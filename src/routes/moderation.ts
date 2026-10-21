import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, type Context } from '../context.js';
import { newId } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { limits } from '../lib/rateLimiter.js';
import { idParam, parse } from '../lib/validation.js';
import { canViewProfile, getProfileRow, hasPrivateAccess } from '../services/profiles.js';
import { blockUser } from './blocks.js';

export const REPORT_CATEGORIES = [
  'spam',
  'scam',
  'fake_profile',
  'harassment',
  'hate',
  'non_consensual_content',
  'underage',
  'impersonation',
  'other',
] as const;

/** Categorias com risco de dano grave entram no topo da fila de revisão. */
const PRIORITY: Partial<Record<(typeof REPORT_CATEGORIES)[number], number>> = {
  underage: 100,
  non_consensual_content: 90,
  scam: 50,
  harassment: 50,
};

const reportSchema = z
  .object({
    targetType: z.enum(['user', 'message', 'photo']),
    targetId: z.string().uuid(),
    category: z.enum(REPORT_CATEGORIES),
    details: z.string().trim().max(2000).default(''),
    alsoBlock: z.boolean().default(false),
  })
  .strict();

const resolveSchema = z
  .object({
    action: z.enum(['dismiss', 'warn', 'remove_content', 'suspend']),
    note: z.string().trim().min(3).max(2000),
  })
  .strict();

interface ReportRow {
  id: string;
  reporter_id: string | null;
  target_user_id: string | null;
  target_type: 'user' | 'message' | 'photo';
  target_id: string;
  category: string;
  details: string;
  evidence: string | null;
  priority: number;
  status: string;
  resolution: string | null;
  resolution_note: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
}

export function moderationRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, limiter, storage } = ctx;
  const staff = { roles: ['moderator', 'admin'] as Array<'moderator' | 'admin'> };

  /**
   * Resolve o alvo da denúncia verificando que o denunciante pode de fato vê-lo. Impede denunciar
   * (e assim obter evidências de) mensagens ou fotos às quais não se tem acesso.
   */
  function resolveTarget(reporterId: string, type: ReportRow['target_type'], targetId: string) {
    if (type === 'user') {
      // Permite denunciar quem bloqueou o denunciante ou foi bloqueado por ele (casos comuns de assédio).
      const row = db.prepare("SELECT id FROM users WHERE id = ? AND status != 'deactivated'").get(targetId) as
        | { id: string }
        | undefined;
      if (!row || row.id === reporterId) throw notFound('Alvo não encontrado');
      const p = getProfileRow(ctx, row.id);
      return { targetUserId: row.id, evidence: p ? JSON.stringify({ displayName: p.display_name, bio: p.bio }) : null };
    }
    if (type === 'message') {
      const m = db
        .prepare(
          `SELECT m.sender_id, m.body, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.id = ? AND (c.user_a = ? OR c.user_b = ?)`,
        )
        .get(targetId, reporterId, reporterId) as { sender_id: string | null; body: string | null; created_at: number } | undefined;
      if (!m || !m.sender_id || m.sender_id === reporterId) throw notFound('Alvo não encontrado');
      return { targetUserId: m.sender_id, evidence: JSON.stringify({ body: m.body, sentAt: m.created_at }) };
    }
    const photo = db.prepare('SELECT id, owner_id, visibility FROM photos WHERE id = ?').get(targetId) as
      | { id: string; owner_id: string; visibility: string }
      | undefined;
    const ok =
      photo &&
      photo.owner_id !== reporterId &&
      canViewProfile(ctx, reporterId, getProfileRow(ctx, photo.owner_id)) &&
      (photo.visibility === 'public' || hasPrivateAccess(ctx, photo.owner_id, reporterId));
    if (!ok) throw notFound('Alvo não encontrado');
    return { targetUserId: photo.owner_id, evidence: JSON.stringify({ photoId: photo.id }) };
  }

  app.post('/reports', async (req, reply) => {
    const user = authenticate(ctx, req, { allowUnverified: false });
    const body = parse(reportSchema, req.body);
    limiter.consume(`report:${user.id}`, limits.reportsPerUser);
    const target = resolveTarget(user.id, body.targetType, body.targetId);

    const existing = db
      .prepare("SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'")
      .get(user.id, body.targetType, body.targetId) as { id: string } | undefined;
    let id = existing?.id;
    if (!id) {
      id = newId();
      db.prepare(
        `INSERT INTO reports (id, reporter_id, target_user_id, target_type, target_id, category, details, evidence, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        user.id,
        target.targetUserId,
        body.targetType,
        body.targetId,
        body.category,
        body.details,
        target.evidence,
        PRIORITY[body.category] ?? 0,
        clock.now(),
      );
    }
    if (body.alsoBlock && target.targetUserId && target.targetUserId !== user.id) {
      blockUser(ctx, user.id, target.targetUserId);
    }
    return reply.code(existing ? 200 : 201).send({ id, status: 'open' });
  });

  app.get('/reports/mine', async (req) => {
    const user = authenticate(ctx, req, { allowSuspended: true });
    const rows = db
      .prepare('SELECT id, target_type, category, status, created_at, reviewed_at FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(user.id) as Array<Pick<ReportRow, 'id' | 'target_type' | 'category' | 'status' | 'created_at' | 'reviewed_at'>>;
    // O denunciante vê o andamento, mas não a ação tomada contra terceiros.
    return {
      reports: rows.map((r) => ({
        id: r.id,
        targetType: r.target_type,
        category: r.category,
        status: r.status === 'open' ? 'em análise' : 'analisada',
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      })),
    };
  });

  // ---- Fila de moderação (somente moderadores e administradores) ----

  app.get('/moderation/reports', async (req) => {
    authenticate(ctx, req, staff);
    const { status } = parse(z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open') }).strict(), req.query);
    const rows = db
      .prepare('SELECT * FROM reports WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT 100')
      .all(status) as ReportRow[];
    return {
      reports: rows.map((r) => ({
        id: r.id,
        reporterId: r.reporter_id,
        targetUserId: r.target_user_id,
        targetType: r.target_type,
        targetId: r.target_id,
        category: r.category,
        details: r.details,
        evidence: r.evidence ? JSON.parse(r.evidence) : null,
        priority: r.priority,
        status: r.status,
        resolution: r.resolution,
        resolutionNote: r.resolution_note,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/moderation/reports/:id/resolve', async (req) => {
    const mod = authenticate(ctx, req, staff);
    const { id } = parse(idParam, req.params);
    const body = parse(resolveSchema, req.body);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
    if (!report) throw notFound();
    if (report.status !== 'open') throw conflict('already_resolved', 'Denúncia já resolvida');

    const target = report.target_user_id
      ? (db.prepare('SELECT id, role FROM users WHERE id = ?').get(report.target_user_id) as { id: string; role: string } | undefined)
      : undefined;
    if (body.action !== 'dismiss') {
      if (!target) throw conflict('target_gone', 'A conta denunciada não existe mais; use "dismiss".');
      if (target.id === mod.id) throw forbidden('conflict_of_interest', 'Você não pode moderar a própria conta');
      // Somente administradores podem agir sobre contas da equipe.
      if (target.role !== 'user' && mod.role !== 'admin') throw forbidden();
    }

    const now = clock.now();
    let fileToDelete: string | null = null;
    db.transaction(() => {
      if (body.action === 'remove_content') {
        if (report.target_type === 'message') {
          db.prepare('UPDATE messages SET body = NULL WHERE id = ?').run(report.target_id);
        } else if (report.target_type === 'photo') {
          const p = db.prepare('SELECT storage_key FROM photos WHERE id = ?').get(report.target_id) as { storage_key: string } | undefined;
          if (p) {
            db.prepare('DELETE FROM photos WHERE id = ?').run(report.target_id);
            fileToDelete = p.storage_key;
          }
        } else {
          // Conteúdo de perfil: limpa a bio.
          db.prepare("UPDATE profiles SET bio = '' WHERE user_id = ?").run(report.target_user_id);
        }
      }
      if (body.action === 'suspend' && target) {
        db.prepare("UPDATE users SET status = 'suspended', suspended_reason = ? WHERE id = ?").run(
          `${report.category}: ${body.note}`,
          target.id,
        );
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, target.id);
      }
      db.prepare(
        'UPDATE reports SET status = ?, resolution = ?, resolution_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      ).run(body.action === 'dismiss' ? 'dismissed' : 'actioned', body.action, body.note, mod.id, now, id);
    })();
    if (fileToDelete) await storage.delete(fileToDelete);
    audit(ctx, `report_${body.action}`, mod.id, report.target_user_id, { reportId: id, category: report.category });
    return { id, status: body.action === 'dismiss' ? 'dismissed' : 'actioned' };
  });

  // ---- Recurso contra suspensão ----

  app.post('/me/appeals', async (req, reply) => {
    const user = authenticate(ctx, req, { allowSuspended: true });
    if (user.status !== 'suspended') throw badRequest('not_suspended', 'Só contas suspensas podem abrir recurso');
    const { message } = parse(z.object({ message: z.string().trim().min(10).max(2000) }).strict(), req.body);
    if (db.prepare("SELECT 1 FROM appeals WHERE user_id = ? AND status = 'open'").get(user.id)) {
      throw conflict('appeal_open', 'Já existe um recurso em análise');
    }
    const id = newId();
    db.prepare('INSERT INTO appeals (id, user_id, message, created_at) VALUES (?, ?, ?, ?)').run(id, user.id, message, clock.now());
    audit(ctx, 'appeal_opened', user.id, user.id, { appealId: id });
    return reply.code(201).send({ id, status: 'open' });
  });

  app.get('/moderation/appeals', async (req) => {
    authenticate(ctx, req, staff);
    const rows = db
      .prepare(
        `SELECT a.*, u.suspended_reason FROM appeals a JOIN users u ON u.id = a.user_id
         WHERE a.status = 'open' ORDER BY a.created_at ASC LIMIT 100`,
      )
      .all() as Array<{ id: string; user_id: string; message: string; created_at: number; suspended_reason: string | null }>;
    return {
      appeals: rows.map((a) => ({
        id: a.id,
        userId: a.user_id,
        message: a.message,
        suspendedReason: a.suspended_reason,
        createdAt: a.created_at,
      })),
    };
  });

  app.post('/moderation/appeals/:id/decide', async (req) => {
    const mod = authenticate(ctx, req, staff);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ decision: z.enum(['upheld', 'reinstated']), note: z.string().trim().min(3).max(2000) }).strict(),
      req.body,
    );
    const appeal = db.prepare("SELECT * FROM appeals WHERE id = ? AND status = 'open'").get(id) as
      | { id: string; user_id: string }
      | undefined;
    if (!appeal) throw notFound();
    if (appeal.user_id === mod.id) throw forbidden('conflict_of_interest', 'Você não pode decidir o próprio recurso');
    const now = clock.now();
    db.transaction(() => {
      db.prepare('UPDATE appeals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?').run(
        body.decision,
        mod.id,
        body.note,
        now,
        id,
      );
      if (body.decision === 'reinstated') {
        db.prepare("UPDATE users SET status = 'active', suspended_reason = NULL WHERE id = ? AND status = 'suspended'").run(
          appeal.user_id,
        );
      }
    })();
    audit(ctx, `appeal_${body.decision}`, mod.id, appeal.user_id, { appealId: id });
    return { id, status: body.decision };
  });
}
