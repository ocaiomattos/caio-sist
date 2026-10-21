import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, type Context } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validation.js';

/** Bloqueia `targetId` e remove acessos a fotos privadas nas duas direções. Idempotente. */
export function blockUser(ctx: Context, blockerId: string, targetId: string): void {
  const { db, clock } = ctx;
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(
      blockerId,
      targetId,
      clock.now(),
    );
    db.prepare(
      'DELETE FROM private_access_grants WHERE (owner_id = ? AND grantee_id = ?) OR (owner_id = ? AND grantee_id = ?)',
    ).run(blockerId, targetId, targetId, blockerId);
  })();
  audit(ctx, 'user_blocked', blockerId, targetId);
}

export function blockRoutes(app: FastifyInstance, ctx: Context): void {
  const { db } = ctx;

  app.get('/blocks', async (req) => {
    const user = authenticate(ctx, req);
    const rows = db
      .prepare(
        `SELECT b.blocked_id, b.created_at, p.display_name FROM blocks b
         LEFT JOIN profiles p ON p.user_id = b.blocked_id
         WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
      )
      .all(user.id) as Array<{ blocked_id: string; created_at: number; display_name: string | null }>;
    return { blocks: rows.map((r) => ({ userId: r.blocked_id, displayName: r.display_name, createdAt: r.created_at })) };
  });

  app.post('/blocks', async (req, reply) => {
    const user = authenticate(ctx, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }).strict(), req.body);
    if (userId === user.id) throw badRequest('invalid_target', 'Você não pode bloquear a si mesmo');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw notFound();
    blockUser(ctx, user.id, userId);
    return reply.code(204).send();
  });

  app.delete('/blocks/:id', async (req, reply) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const res = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, id);
    if (res.changes === 0) throw notFound();
    return reply.code(204).send();
  });
}
