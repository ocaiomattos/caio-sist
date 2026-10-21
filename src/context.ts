import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';
import type { Clock } from './lib/clock.js';
import { hashToken } from './lib/crypto.js';
import { forbidden, unauthorized } from './lib/errors.js';
import type { Mailer } from './lib/mailer.js';
import type { RateLimiter } from './lib/rateLimiter.js';
import type { MediaStorage } from './lib/storage.js';

export interface Context {
  config: AppConfig;
  db: DB;
  clock: Clock;
  mailer: Mailer;
  storage: MediaStorage;
  limiter: RateLimiter;
}

export type Role = 'user' | 'moderator' | 'admin';
export type Status = 'active' | 'deactivated' | 'suspended';

export interface AuthUser {
  id: string;
  sessionId: string;
  email: string;
  role: Role;
  status: Status;
  emailVerified: boolean;
}

export interface AuthOptions {
  /** Usuário suspenso pode acessar a rota (ex.: ver motivo, recorrer, exportar ou excluir dados). */
  allowSuspended?: boolean;
  /** Conta com e-mail ainda não verificado pode acessar a rota. */
  allowUnverified?: boolean;
  /** Conta desativada pode acessar a rota (ex.: reativar). */
  allowDeactivated?: boolean;
  roles?: Role[];
}

interface SessionRow {
  session_id: string;
  user_id: string;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  email: string;
  role: Role;
  status: Status;
  email_verified_at: number | null;
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  return token.length > 0 && token.length <= 128 ? token : null;
}

/** Resolve a sessão a partir do token Bearer. Toda autorização é decidida aqui, no servidor. */
export function authenticate(ctx: Context, req: FastifyRequest, opts: AuthOptions = {}): AuthUser {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  const now = ctx.clock.now();
  const row = ctx.db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.expires_at, s.last_seen_at, s.revoked_at,
              u.email, u.role, u.status, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as SessionRow | undefined;

  if (
    !row ||
    row.revoked_at !== null ||
    row.expires_at <= now ||
    row.last_seen_at + ctx.config.sessionIdleMs <= now
  ) {
    throw unauthorized('Sessão inválida ou expirada');
  }

  // Atualiza o "visto por último" no máximo a cada minuto para evitar escrita a cada requisição.
  if (now - row.last_seen_at > 60_000) {
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);
    ctx.db.prepare('UPDATE profiles SET last_active_at = ? WHERE user_id = ?').run(now, row.user_id);
  }

  const user: AuthUser = {
    id: row.user_id,
    sessionId: row.session_id,
    email: row.email,
    role: row.role,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
  };

  if (user.status === 'suspended' && !opts.allowSuspended) {
    throw forbidden('account_suspended', 'Conta suspensa. Consulte o motivo e o recurso em /me.');
  }
  if (user.status === 'deactivated' && !opts.allowDeactivated) {
    throw forbidden('account_deactivated', 'Conta desativada. Reative-a para usar este recurso.');
  }
  if (!user.emailVerified && !opts.allowUnverified) {
    throw forbidden('email_not_verified', 'Confirme seu e-mail para usar este recurso.');
  }
  if (opts.roles && !opts.roles.includes(user.role)) {
    throw forbidden();
  }
  return user;
}

export function audit(
  ctx: Context,
  action: string,
  actorId: string | null,
  targetUserId: string | null,
  details: Record<string, unknown> = {},
): void {
  ctx.db
    .prepare('INSERT INTO audit_log (actor_id, action, target_user_id, details, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(actorId, action, targetUserId, JSON.stringify(details), ctx.clock.now());
}

/** true se qualquer um dos dois bloqueou o outro. */
export function isBlockedEitherWay(ctx: Context, a: string, b: string): boolean {
  return (
    ctx.db
      .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(a, b, b, a) !== undefined
  );
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
