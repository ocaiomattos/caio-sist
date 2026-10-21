import { describe, expect, it } from 'vitest';
import { createUser, lastTokenFor, PASSWORD, setup } from './helpers.js';

const register = (email: string, extra: Record<string, unknown> = {}) => ({
  method: 'POST' as const,
  url: '/auth/register',
  payload: { email, password: PASSWORD, birthdate: '1990-01-01', displayName: 'Ana', acceptTerms: true, ...extra },
});

describe('cadastro', () => {
  it('cria conta não verificada e envia e-mail de confirmação', async () => {
    const env = await setup();
    const res = await env.req(register('ana@example.test'));
    expect(res.statusCode).toBe(202);
    const row = env.ctx.db.prepare('SELECT password_hash, email_verified_at FROM users WHERE email = ?').get('ana@example.test') as {
      password_hash: string;
      email_verified_at: number | null;
    };
    expect(row.email_verified_at).toBeNull();
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(env.mailer.outbox).toHaveLength(1);
  });

  it('não revela se o e-mail já está cadastrado (anti-enumeração)', async () => {
    const env = await setup();
    const first = await env.req(register('dup@example.test'));
    const second = await env.req(register('DUP@example.test'));
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    const { n } = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(n).toBe(1);
  });

  it('rejeita menores de 18 anos no servidor', async () => {
    const env = await setup();
    // Relógio de teste: 2026-10-21. Nascido em 2008-10-22 tem 17 anos.
    const res = await env.req(register('teen@example.test', { birthdate: '2008-10-22' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('underage');
    const ok = await env.req(register('adult@example.test', { birthdate: '2008-10-21' }));
    expect(ok.statusCode).toBe(202);
  });

  it('rejeita datas inválidas, senha fraca e campos extras', async () => {
    const env = await setup();
    expect((await env.req(register('a@example.test', { birthdate: '1990-02-30' }))).statusCode).toBe(400);
    expect((await env.req(register('a@example.test', { password: 'curta' }))).statusCode).toBe(400);
    expect((await env.req(register('a@example.test', { password: 'password123' }))).statusCode).toBe(400);
    const extra = await env.req(register('a@example.test', { role: 'admin' }));
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.code).toBe('validation_error');
  });

  it('limita cadastros por IP', async () => {
    const env = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await env.req({ ...register(`r${i}@example.test`), remoteAddress: '9.9.9.9' })).statusCode).toBe(202);
    }
    const res = await env.req({ ...register('r6@example.test'), remoteAddress: '9.9.9.9' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('token de verificação é de uso único', async () => {
    const env = await setup();
    await env.req(register('v@example.test'));
    const token = lastTokenFor(env, 'v@example.test', '/verify-email');
    expect((await env.req({ method: 'POST', url: '/auth/verify-email', payload: { token } })).statusCode).toBe(200);
    expect((await env.req({ method: 'POST', url: '/auth/verify-email', payload: { token } })).statusCode).toBe(400);
  });

  it('conta não verificada pode logar mas não usa recursos sociais', async () => {
    const env = await setup();
    await env.req(register('nv@example.test'));
    const login = await env.req({ method: 'POST', url: '/auth/login', payload: { email: 'nv@example.test', password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.emailVerified).toBe(false);
    const res = await env.req({ method: 'GET', url: '/discover', token: login.json().token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_not_verified');
  });
});

describe('login e sessões', () => {
  it('mensagem idêntica para e-mail inexistente e senha errada', async () => {
    const env = await setup();
    const u = await createUser(env);
    const wrong = await env.req({ method: 'POST', url: '/auth/login', payload: { email: u.email, password: 'senha-errada-123' } });
    const missing = await env.req({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@example.test', password: 'x-123456789' } });
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json()).toEqual(missing.json());
  });

  it('limita tentativas falhas por conta e libera após a janela', async () => {
    const env = await setup();
    const u = await createUser(env);
    for (let i = 0; i < 10; i++) {
      const r = await env.req({ method: 'POST', url: '/auth/login', remoteAddress: `1.1.1.${i}`, payload: { email: u.email, password: 'errada-0000000' } });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await env.req({ method: 'POST', url: '/auth/login', remoteAddress: '1.1.2.1', payload: { email: u.email, password: PASSWORD } });
    expect(blocked.statusCode).toBe(429);
    env.clock.advance(16 * 60 * 1000);
    const ok = await env.req({ method: 'POST', url: '/auth/login', remoteAddress: '1.1.2.1', payload: { email: u.email, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
  });

  it('token é armazenado apenas como hash', async () => {
    const env = await setup();
    const u = await createUser(env);
    const rows = env.ctx.db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>;
    expect(rows.some((r) => r.token_hash === u.token)).toBe(false);
  });

  it('logout revoga a sessão', async () => {
    const env = await setup();
    const u = await createUser(env);
    expect((await env.req({ method: 'POST', url: '/auth/logout', token: u.token })).statusCode).toBe(204);
    expect((await env.req({ method: 'GET', url: '/me', token: u.token })).statusCode).toBe(401);
  });

  it('sessão expira por inatividade', async () => {
    const env = await setup();
    const u = await createUser(env);
    env.clock.advance(15 * 24 * 60 * 60 * 1000);
    expect((await env.req({ method: 'GET', url: '/me', token: u.token })).statusCode).toBe(401);
  });

  it('usuário lista e revoga apenas as próprias sessões', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const list = await env.req({ method: 'GET', url: '/auth/sessions', token: b.token });
    const bSession = list.json().sessions[0].id;
    const res = await env.req({ method: 'DELETE', url: `/auth/sessions/${bSession}`, token: a.token });
    expect(res.statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: '/me', token: b.token })).statusCode).toBe(200);
  });

  it('rejeita tokens malformados ou ausentes', async () => {
    const env = await setup();
    expect((await env.req({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await env.req({ method: 'GET', url: '/me', headers: { authorization: 'Bearer forjado' } })).statusCode).toBe(401);
    expect((await env.req({ method: 'GET', url: '/me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });
});

describe('recuperação de senha', () => {
  it('resposta idêntica para e-mail existente e inexistente', async () => {
    const env = await setup();
    const u = await createUser(env);
    const before = env.mailer.outbox.length;
    const a = await env.req({ method: 'POST', url: '/auth/password/forgot', payload: { email: u.email } });
    const b = await env.req({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'ghost@example.test' } });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json()).toEqual(b.json());
    expect(env.mailer.outbox.length).toBe(before + 1);
  });

  it('redefine a senha, revoga sessões e o link não pode ser reutilizado', async () => {
    const env = await setup();
    const u = await createUser(env);
    await env.req({ method: 'POST', url: '/auth/password/forgot', payload: { email: u.email } });
    const token = lastTokenFor(env, u.email, '/reset-password');
    const newPassword = 'nova senha muito boa';
    const res = await env.req({ method: 'POST', url: '/auth/password/reset', payload: { token, newPassword } });
    expect(res.statusCode).toBe(200);
    expect((await env.req({ method: 'GET', url: '/me', token: u.token })).statusCode).toBe(401);
    const reuse = await env.req({ method: 'POST', url: '/auth/password/reset', payload: { token, newPassword: 'outra senha qualquer' } });
    expect(reuse.statusCode).toBe(400);
    const login = await env.req({ method: 'POST', url: '/auth/login', payload: { email: u.email, password: newPassword } });
    expect(login.statusCode).toBe(200);
  });

  it('link expira em 30 minutos e só o link mais recente vale', async () => {
    const env = await setup();
    const u = await createUser(env);
    await env.req({ method: 'POST', url: '/auth/password/forgot', payload: { email: u.email } });
    const first = lastTokenFor(env, u.email, '/reset-password');
    await env.req({ method: 'POST', url: '/auth/password/forgot', payload: { email: u.email } });
    const second = lastTokenFor(env, u.email, '/reset-password');
    expect((await env.req({ method: 'POST', url: '/auth/password/reset', payload: { token: first, newPassword: 'nova senha muito boa' } })).statusCode).toBe(400);
    env.clock.advance(31 * 60 * 1000);
    expect((await env.req({ method: 'POST', url: '/auth/password/reset', payload: { token: second, newPassword: 'nova senha muito boa' } })).statusCode).toBe(400);
  });

  it('token de verificação de e-mail não serve para redefinir senha', async () => {
    const env = await setup();
    await env.req(register('mix@example.test'));
    const verifyToken = lastTokenFor(env, 'mix@example.test', '/verify-email');
    const res = await env.req({ method: 'POST', url: '/auth/password/reset', payload: { token: verifyToken, newPassword: 'nova senha muito boa' } });
    expect(res.statusCode).toBe(400);
  });

  it('troca de senha exige a senha atual e encerra as outras sessões', async () => {
    const env = await setup();
    const u = await createUser(env);
    const other = (await env.req({ method: 'POST', url: '/auth/login', payload: { email: u.email, password: PASSWORD } })).json().token;
    const bad = await env.req({ method: 'POST', url: '/auth/password/change', token: u.token, payload: { currentPassword: 'errada-errada', newPassword: 'nova senha muito boa' } });
    expect(bad.statusCode).toBe(401);
    const ok = await env.req({ method: 'POST', url: '/auth/password/change', token: u.token, payload: { currentPassword: PASSWORD, newPassword: 'nova senha muito boa' } });
    expect(ok.statusCode).toBe(200);
    expect((await env.req({ method: 'GET', url: '/me', token: u.token })).statusCode).toBe(200);
    expect((await env.req({ method: 'GET', url: '/me', token: other })).statusCode).toBe(401);
  });
});

describe('concorrência', () => {
  it('cadastros simultâneos com o mesmo e-mail não geram erro 500', async () => {
    const env = await setup();
    const results = await Promise.all(
      [1, 2, 3].map((i) => env.req({ ...register('race@example.test'), remoteAddress: `5.5.5.${i}` })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    const { n } = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(n).toBe(1);
  });
});
