import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, type Context } from '../context.js';
import { hashToken } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import { parse } from '../lib/validation.js';

const anyStatus = { allowSuspended: true, allowUnverified: true, allowDeactivated: true };

export const emailHash = (email: string) => hashToken(`email:${email.toLowerCase()}`);

export function accountRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, storage } = ctx;

  app.get('/me', async (req) => {
    const user = authenticate(ctx, req, anyStatus);
    const row = db
      .prepare('SELECT email, role, status, email_verified_at, suspended_reason, created_at FROM users WHERE id = ?')
      .get(user.id) as {
      email: string;
      role: string;
      status: string;
      email_verified_at: number | null;
      suspended_reason: string | null;
      created_at: number;
    };
    const appeal = db
      .prepare('SELECT id, status, decision_note, created_at FROM appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(user.id) as { id: string; status: string; decision_note: string | null; created_at: number } | undefined;
    return {
      id: user.id,
      email: row.email,
      role: row.role,
      status: row.status,
      emailVerified: row.email_verified_at !== null,
      createdAt: row.created_at,
      // Transparência: o usuário suspenso vê o motivo e o andamento do recurso.
      suspension:
        row.status === 'suspended'
          ? {
              reason: row.suspended_reason,
              appeal: appeal ? { id: appeal.id, status: appeal.status, decisionNote: appeal.decision_note } : null,
            }
          : null,
    };
  });

  /** Desativação reversível: o perfil some imediatamente da descoberta, das buscas e de visualizações diretas. */
  app.post('/me/deactivate', async (req) => {
    const user = authenticate(ctx, req, { allowUnverified: true });
    db.prepare("UPDATE users SET status = 'deactivated' WHERE id = ? AND status = 'active'").run(user.id);
    audit(ctx, 'account_deactivated', user.id, user.id);
    return { status: 'deactivated' };
  });

  app.post('/me/reactivate', async (req) => {
    const user = authenticate(ctx, req, { allowUnverified: true, allowDeactivated: true });
    db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'deactivated'").run(user.id);
    audit(ctx, 'account_reactivated', user.id, user.id);
    return { status: 'active' };
  });

  /** Portabilidade (LGPD art. 18, V): exporta os dados que o titular forneceu ou gerou. */
  app.get('/me/export', async (req, reply) => {
    const user = authenticate(ctx, req, anyStatus);
    const q = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
    const data = {
      exportedAt: new Date(clock.now()).toISOString(),
      account: db.prepare('SELECT id, email, birthdate, role, status, email_verified_at, created_at FROM users WHERE id = ?').get(user.id),
      profile: db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(user.id),
      photos: q('SELECT id, visibility, width, height, bytes, created_at FROM photos WHERE owner_id = ?', user.id),
      messagesSent: q('SELECT id, conversation_id, body, created_at FROM messages WHERE sender_id = ? ORDER BY seq', user.id),
      blocks: q('SELECT blocked_id, created_at FROM blocks WHERE blocker_id = ?', user.id),
      privateAccessGranted: q('SELECT grantee_id, created_at FROM private_access_grants WHERE owner_id = ?', user.id),
      reportsFiled: q('SELECT id, target_type, target_id, category, details, status, created_at FROM reports WHERE reporter_id = ?', user.id),
      appeals: q('SELECT id, message, status, decision_note, created_at FROM appeals WHERE user_id = ?', user.id),
      sessions: q('SELECT id, user_agent, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE user_id = ?', user.id),
    };
    audit(ctx, 'data_exported', user.id, user.id);
    return reply.header('content-disposition', 'attachment; filename="meus-dados.json"').send(data);
  });

  /**
   * Exclusão definitiva. Exige senha e confirmação explícita. Remove perfil, fotos (arquivos inclusive),
   * sessões, bloqueios e acessos; o texto das mensagens enviadas é apagado e o remetente vira nulo.
   */
  app.delete('/me', async (req, reply) => {
    const user = authenticate(ctx, req, anyStatus);
    const body = parse(
      z.object({ password: z.string().min(1).max(128), confirm: z.literal('EXCLUIR', { message: 'Digite EXCLUIR para confirmar' }) }).strict(),
      req.body,
    );
    const row = db.prepare('SELECT email, password_hash, status FROM users WHERE id = ?').get(user.id) as {
      email: string;
      password_hash: string;
      status: string;
    };
    if (!(await verifyPassword(body.password, row.password_hash))) {
      throw new AppError(401, 'invalid_credentials', 'Senha incorreta');
    }
    if (user.role === 'admin') {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
      if (n <= 1) throw badRequest('last_admin', 'Promova outro administrador antes de excluir esta conta');
    }

    const keys = (db.prepare('SELECT storage_key FROM photos WHERE owner_id = ?').all(user.id) as Array<{ storage_key: string }>).map(
      (r) => r.storage_key,
    );
    db.transaction(() => {
      db.prepare('UPDATE messages SET body = NULL, client_id = NULL WHERE sender_id = ?').run(user.id);
      if (row.status === 'suspended') {
        db.prepare('INSERT OR IGNORE INTO restricted_emails (email_hash, reason, created_at) VALUES (?, ?, ?)').run(
          emailHash(row.email),
          'deleted_while_suspended',
          clock.now(),
        );
      }
      // FKs com ON DELETE CASCADE / SET NULL completam a limpeza (ver db/migrations.ts).
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    await Promise.all(keys.map((k) => storage.delete(k)));
    audit(ctx, 'account_deleted', null, user.id);
    return reply.code(204).send();
  });
}
