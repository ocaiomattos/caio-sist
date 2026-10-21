import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, clientIp, type Context } from '../context.js';
import { hashToken, newId, newToken } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { ageFromBirthdate } from '../lib/geo.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password.js';
import { limits } from '../lib/rateLimiter.js';
import { idParam, parse } from '../lib/validation.js';
import { emailHash } from './account.js';

const MIN_AGE = 18;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'E-mail inválido' }));

// Lista curta de senhas extremamente comuns; complementa (não substitui) o comprimento mínimo.
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', 'password123', 'qwertyuiop', 'senha12345', 'iloveyou12',
  'password1234', 'qwerty12345', 'abcdefghij', '0123456789', '1111111111', 'senhasenha',
]);

const passwordSchema = z
  .string()
  .min(10, 'A senha deve ter pelo menos 10 caracteres')
  .max(128, 'A senha deve ter no máximo 128 caracteres')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'Senha muito comum; escolha outra');

const birthdateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Data inválida');

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    birthdate: birthdateSchema,
    displayName: z.string().trim().min(2).max(40),
    acceptTerms: z.literal(true, { message: 'É necessário aceitar os termos' }),
  })
  .strict();

const GENERIC_REGISTER_RESPONSE = {
  message: 'Se os dados forem válidos, enviamos um e-mail para concluir o cadastro.',
};
const GENERIC_FORGOT_RESPONSE = {
  message: 'Se existir uma conta com este e-mail, enviamos as instruções de redefinição.',
};

function invalidCredentials(): AppError {
  return new AppError(401, 'invalid_credentials', 'E-mail ou senha incorretos');
}

export function authRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, config, limiter, mailer } = ctx;

  function issueOneTimeToken(userId: string, purpose: 'verify_email' | 'reset_password'): string {
    const now = clock.now();
    const ttl = purpose === 'verify_email' ? config.emailVerificationTtlMs : config.passwordResetTtlMs;
    // Invalida tokens anteriores do mesmo propósito: só o link mais recente funciona.
    db.prepare('UPDATE one_time_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(
      now,
      userId,
      purpose,
    );
    const token = newToken();
    db.prepare(
      'INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(newId(), userId, purpose, hashToken(token), now, now + ttl);
    return token;
  }

  /** Consome um token de uso único de forma atômica. Retorna o user_id ou lança erro genérico. */
  function consumeOneTimeToken(token: string, purpose: 'verify_email' | 'reset_password'): string {
    const now = clock.now();
    const row = db
      .prepare(
        `UPDATE one_time_tokens SET used_at = ?
         WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
         RETURNING user_id`,
      )
      .get(now, hashToken(token), purpose, now) as { user_id: string } | undefined;
    if (!row) throw badRequest('invalid_token', 'Link inválido ou expirado. Solicite um novo.');
    return row.user_id;
  }

  async function sendSafely(to: string, subject: string, text: string): Promise<void> {
    try {
      await mailer.send({ to, subject, text });
    } catch (err) {
      // Não registra destinatário nem conteúdo (o conteúdo pode conter tokens).
      app.log.error({ err: (err as Error).message }, 'falha ao enviar e-mail');
    }
  }

  function createSession(userId: string, userAgent: string) {
    const now = clock.now();
    const token = newToken();
    const id = newId();
    const expiresAt = now + config.sessionTtlMs;
    db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, hashToken(token), userAgent.slice(0, 200), now, now, expiresAt);
    return { token, expiresAt };
  }

  app.post('/auth/register', async (req, reply) => {
    limiter.consume(`register:ip:${clientIp(req)}`, limits.registerPerIp);
    const body = parse(registerSchema, req.body);
    const now = clock.now();
    if (ageFromBirthdate(body.birthdate, now) < MIN_AGE) {
      throw badRequest('underage', `É necessário ter pelo menos ${MIN_AGE} anos.`);
    }

    // O hash é calculado sempre, para que o tempo de resposta não revele se o e-mail já existe.
    const passwordHash = await hashPassword(body.password);
    const existing = db.prepare('SELECT id, email_verified_at FROM users WHERE email = ?').get(body.email) as
      | { id: string; email_verified_at: number | null }
      | undefined;

    if (db.prepare('SELECT 1 FROM restricted_emails WHERE email_hash = ?').get(emailHash(body.email))) {
      // Conta suspensa excluída: não recria, sem revelar o motivo nesta resposta.
      return reply.code(202).send(GENERIC_REGISTER_RESPONSE);
    }
    if (existing) {
      if (existing.email_verified_at === null) {
        const token = issueOneTimeToken(existing.id, 'verify_email');
        await sendSafely(body.email, 'Confirme seu e-mail', `Confirme seu e-mail: ${config.publicAppUrl}/verify-email?token=${token}`);
      } else {
        await sendSafely(
          body.email,
          'Tentativa de cadastro',
          `Alguém tentou criar uma conta com este e-mail. Se foi você, faça login ou redefina a senha em ${config.publicAppUrl}/forgot-password.`,
        );
      }
      return reply.code(202).send(GENERIC_REGISTER_RESPONSE);
    }

    const id = newId();
    try {
      db.transaction(() => {
        db.prepare(
          'INSERT INTO users (id, email, password_hash, birthdate, password_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, body.email, passwordHash, body.birthdate, now, now);
        db.prepare('INSERT INTO profiles (user_id, display_name, last_active_at, updated_at) VALUES (?, ?, ?, ?)').run(
          id,
          body.displayName,
          now,
          now,
        );
      })();
    } catch (err) {
      // Cadastro concorrente com o mesmo e-mail: mesma resposta genérica, sem erro 500.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(202).send(GENERIC_REGISTER_RESPONSE);
      throw err;
    }
    audit(ctx, 'account_created', id, id);
    const token = issueOneTimeToken(id, 'verify_email');
    await sendSafely(body.email, 'Confirme seu e-mail', `Confirme seu e-mail: ${config.publicAppUrl}/verify-email?token=${token}`);
    return reply.code(202).send(GENERIC_REGISTER_RESPONSE);
  });

  app.post('/auth/verify-email', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(128) }).strict(), req.body);
    const userId = consumeOneTimeToken(token, 'verify_email');
    db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(clock.now(), userId);
    audit(ctx, 'email_verified', userId, userId);
    return { message: 'E-mail confirmado.' };
  });

  app.post('/auth/resend-verification', async (req, reply) => {
    const { email } = parse(z.object({ email: emailSchema }).strict(), req.body);
    limiter.consume(`verify-resend:${email}`, limits.verificationResendPerEmail);
    const user = db.prepare('SELECT id, email_verified_at FROM users WHERE email = ?').get(email) as
      | { id: string; email_verified_at: number | null }
      | undefined;
    if (user && user.email_verified_at === null) {
      const token = issueOneTimeToken(user.id, 'verify_email');
      await sendSafely(email, 'Confirme seu e-mail', `Confirme seu e-mail: ${config.publicAppUrl}/verify-email?token=${token}`);
    }
    return reply.code(202).send(GENERIC_REGISTER_RESPONSE);
  });

  app.post('/auth/login', async (req) => {
    limiter.consume(`login:ip:${clientIp(req)}`, limits.loginPerIp);
    const body = parse(z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict(), req.body);
    const failKey = `login:fail:${body.email}`;
    // Limite por conta conta apenas falhas; não bloqueia permanentemente (evita negação de serviço contra a vítima).
    limiter.assertNotLimited(failKey, limits.loginFailuresPerAccount);

    const user = db.prepare('SELECT id, password_hash, status, email_verified_at FROM users WHERE email = ?').get(body.email) as
      | { id: string; password_hash: string; status: string; email_verified_at: number | null }
      | undefined;

    if (!user) {
      await burnPasswordCheck(body.password);
      limiter.record(failKey, limits.loginFailuresPerAccount);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      limiter.record(failKey, limits.loginFailuresPerAccount);
      audit(ctx, 'login_failed', null, user.id);
      throw invalidCredentials();
    }

    limiter.reset(failKey);
    const session = createSession(user.id, String(req.headers['user-agent'] ?? ''));
    audit(ctx, 'login', user.id, user.id);
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, status: user.status, emailVerified: user.email_verified_at !== null },
    };
  });

  const sessionAuth = { allowSuspended: true, allowUnverified: true, allowDeactivated: true };

  app.post('/auth/logout', async (req, reply) => {
    const user = authenticate(ctx, req, sessionAuth);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(clock.now(), user.sessionId);
    return reply.code(204).send();
  });

  app.post('/auth/logout-all', async (req, reply) => {
    const user = authenticate(ctx, req, sessionAuth);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(clock.now(), user.id);
    audit(ctx, 'logout_all', user.id, user.id);
    return reply.code(204).send();
  });

  app.get('/auth/sessions', async (req) => {
    const user = authenticate(ctx, req, sessionAuth);
    const now = clock.now();
    const rows = db
      .prepare(
        `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
      )
      .all(user.id, now) as Array<{ id: string; user_agent: string; created_at: number; last_seen_at: number; expires_at: number }>;
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        current: r.id === user.sessionId,
      })),
    };
  });

  app.delete('/auth/sessions/:id', async (req, reply) => {
    const user = authenticate(ctx, req, sessionAuth);
    const { id } = parse(idParam, req.params);
    // Filtra pelo dono: a sessão de outro usuário é tratada como inexistente.
    const res = db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(clock.now(), id, user.id);
    if (res.changes === 0) throw notFound();
    return reply.code(204).send();
  });

  app.post('/auth/password/forgot', async (req, reply) => {
    const { email } = parse(z.object({ email: emailSchema }).strict(), req.body);
    limiter.consume(`forgot:ip:${clientIp(req)}`, limits.passwordResetPerIp);
    limiter.consume(`forgot:email:${email}`, limits.passwordResetPerEmail);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (user) {
      const token = issueOneTimeToken(user.id, 'reset_password');
      audit(ctx, 'password_reset_requested', null, user.id);
      await sendSafely(
        email,
        'Redefinição de senha',
        `Para redefinir sua senha, acesse ${config.publicAppUrl}/reset-password?token=${token}\n` +
          'O link expira em 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.',
      );
    }
    return reply.code(202).send(GENERIC_FORGOT_RESPONSE);
  });

  app.post('/auth/password/reset', async (req) => {
    const body = parse(z.object({ token: z.string().min(1).max(128), newPassword: passwordSchema }).strict(), req.body);
    const userId = consumeOneTimeToken(body.token, 'reset_password');
    const hash = await hashPassword(body.newPassword);
    const now = clock.now();
    const { email } = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string };
    db.transaction(() => {
      // Quem recebeu o link comprovou acesso à caixa de e-mail, então o e-mail fica verificado.
      db.prepare(
        'UPDATE users SET password_hash = ?, password_changed_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
      ).run(hash, now, now, userId);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      db.prepare("UPDATE one_time_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL").run(
        now,
        userId,
      );
    })();
    limiter.reset(`login:fail:${email}`);
    audit(ctx, 'password_reset', userId, userId);
    await sendSafely(email, 'Sua senha foi alterada', 'Sua senha foi redefinida e todas as sessões foram encerradas. Se não foi você, contate o suporte.');
    return { message: 'Senha redefinida. Faça login novamente.' };
  });

  app.post('/auth/password/change', async (req) => {
    const user = authenticate(ctx, req, { allowUnverified: true, allowDeactivated: true });
    const body = parse(
      z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict(),
      req.body,
    );
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw invalidCredentials();
    const now = clock.now();
    const hash = await hashPassword(body.newPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, now, user.id);
      // Mantém a sessão atual e encerra as demais.
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(
        now,
        user.id,
        user.sessionId,
      );
    })();
    audit(ctx, 'password_changed', user.id, user.id);
    return { message: 'Senha alterada. As outras sessões foram encerradas.' };
  });
}
