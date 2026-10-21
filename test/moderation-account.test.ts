import { describe, expect, it } from 'vitest';
import { createUser, PASSWORD, setup, type TestEnv, type TestUser } from './helpers.js';

const report = (env: TestEnv, by: TestUser, payload: Record<string, unknown>) =>
  env.req({ method: 'POST', url: '/reports', token: by.token, payload });

async function sendMessage(env: TestEnv, from: TestUser, to: TestUser, body: string) {
  return (await env.req({ method: 'POST', url: '/messages', token: from.token, payload: { recipientId: to.id, body } })).json().message;
}

describe('denúncias', () => {
  it('denúncia de mensagem preserva evidência e pode bloquear junto', async () => {
    const env = await setup();
    const victim = await createUser(env);
    const harasser = await createUser(env);
    const mod = await createUser(env, { role: 'moderator' });
    const msg = await sendMessage(env, harasser, victim, 'mensagem ofensiva');
    const res = await report(env, victim, { targetType: 'message', targetId: msg.id, category: 'harassment', alsoBlock: true });
    expect(res.statusCode).toBe(201);
    expect((await env.req({ method: 'GET', url: `/users/${victim.id}`, token: harasser.token })).statusCode).toBe(404);
    const queue = (await env.req({ method: 'GET', url: '/moderation/reports', token: mod.token })).json().reports;
    expect(queue[0].evidence.body).toBe('mensagem ofensiva');
    expect(queue[0].targetUserId).toBe(harasser.id);
  });

  it('não permite denunciar (e ler) mensagem de conversa alheia', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const outsider = await createUser(env);
    const msg = await sendMessage(env, a, b, 'privado');
    const res = await report(env, outsider, { targetType: 'message', targetId: msg.id, category: 'spam' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('privado');
  });

  it('denúncia repetida do mesmo alvo é idempotente', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const first = await report(env, a, { targetType: 'user', targetId: b.id, category: 'fake_profile' });
    const again = await report(env, a, { targetType: 'user', targetId: b.id, category: 'fake_profile' });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it('categorias graves têm prioridade na fila', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const c = await createUser(env);
    const mod = await createUser(env, { role: 'moderator' });
    await report(env, a, { targetType: 'user', targetId: b.id, category: 'spam' });
    await report(env, a, { targetType: 'user', targetId: c.id, category: 'underage' });
    const queue = (await env.req({ method: 'GET', url: '/moderation/reports', token: mod.token })).json().reports;
    expect(queue[0].category).toBe('underage');
  });

  it('usuário comum não acessa a fila nem resolve denúncias (escalada de privilégio)', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const r = (await report(env, a, { targetType: 'user', targetId: b.id, category: 'spam' })).json();
    expect((await env.req({ method: 'GET', url: '/moderation/reports', token: a.token })).statusCode).toBe(403);
    const resolve = await env.req({ method: 'POST', url: `/moderation/reports/${r.id}/resolve`, token: a.token, payload: { action: 'suspend', note: 'tentativa' } });
    expect(resolve.statusCode).toBe(403);
  });
});

describe('suspensão e recurso', () => {
  async function suspended(env: TestEnv) {
    const user = await createUser(env);
    const reporter = await createUser(env);
    const mod = await createUser(env, { role: 'moderator' });
    const r = (await report(env, reporter, { targetType: 'user', targetId: user.id, category: 'scam' })).json();
    const res = await env.req({ method: 'POST', url: `/moderation/reports/${r.id}/resolve`, token: mod.token, payload: { action: 'suspend', note: 'pedidos de gift card' } });
    expect(res.statusCode).toBe(200);
    return { user, mod };
  }

  it('suspensão revoga sessões; usuário vê o motivo e pode recorrer', async () => {
    const env = await setup();
    const { user, mod } = await suspended(env);
    expect((await env.req({ method: 'GET', url: '/me', token: user.token })).statusCode).toBe(401);

    const login = await env.req({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: PASSWORD } });
    const token = login.json().token;
    const me = (await env.req({ method: 'GET', url: '/me', token })).json();
    expect(me.status).toBe('suspended');
    expect(me.suspension.reason).toContain('gift card');
    expect((await env.req({ method: 'GET', url: '/discover', token })).statusCode).toBe(403);

    const appeal = await env.req({ method: 'POST', url: '/me/appeals', token, payload: { message: 'Foi um engano, posso explicar.' } });
    expect(appeal.statusCode).toBe(201);
    expect((await env.req({ method: 'POST', url: '/me/appeals', token, payload: { message: 'Segundo recurso duplicado.' } })).statusCode).toBe(409);

    const decide = await env.req({ method: 'POST', url: `/moderation/appeals/${appeal.json().id}/decide`, token: mod.token, payload: { decision: 'reinstated', note: 'evidência insuficiente' } });
    expect(decide.statusCode).toBe(200);
    expect((await env.req({ method: 'GET', url: '/discover', token })).statusCode).toBe(200);

    const actions = env.ctx.db.prepare('SELECT action FROM audit_log WHERE target_user_id = ?').all(user.id).map((r) => (r as { action: string }).action);
    expect(actions).toEqual(expect.arrayContaining(['report_suspend', 'appeal_opened', 'appeal_reinstated']));
  });

  it('moderador não pode agir sobre contas da equipe nem sobre si mesmo', async () => {
    const env = await setup();
    const reporter = await createUser(env);
    const mod1 = await createUser(env, { role: 'moderator' });
    const mod2 = await createUser(env, { role: 'moderator' });
    const r = (await report(env, reporter, { targetType: 'user', targetId: mod2.id, category: 'other' })).json();
    const res = await env.req({ method: 'POST', url: `/moderation/reports/${r.id}/resolve`, token: mod1.token, payload: { action: 'suspend', note: 'teste' } });
    expect(res.statusCode).toBe(403);
    const self = await env.req({ method: 'POST', url: `/moderation/reports/${r.id}/resolve`, token: mod2.token, payload: { action: 'suspend', note: 'teste' } });
    expect(self.statusCode).toBe(403);
  });
});

describe('conta: desativação, exportação e exclusão', () => {
  it('perfil desativado some imediatamente para terceiros e volta ao reativar', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await env.req({ method: 'POST', url: '/me/deactivate', token: b.token });
    expect((await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token })).statusCode).toBe(404);
    const ids = (await env.req({ method: 'GET', url: '/discover', token: a.token })).json().results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(b.id);
    expect((await env.req({ method: 'POST', url: '/me/reactivate', token: b.token })).statusCode).toBe(200);
    expect((await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token })).statusCode).toBe(200);
  });

  it('exportação contém somente os dados do próprio titular', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await sendMessage(env, a, b, 'minha mensagem');
    await sendMessage(env, b, a, 'mensagem do outro');
    const res = await env.req({ method: 'GET', url: '/me/export', token: a.token });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.json();
    expect(data.account.email).toBe(a.email);
    expect(data.messagesSent.map((m: { body: string }) => m.body)).toEqual(['minha mensagem']);
    expect(res.body).not.toContain('mensagem do outro');
    expect(res.body).not.toContain('password_hash');
    expect(res.body).not.toContain('token_hash');
  });

  it('exclusão exige senha e confirmação, remove dados e anonimiza mensagens', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await sendMessage(env, a, b, 'conteúdo que deve sumir');
    expect((await env.req({ method: 'DELETE', url: '/me', token: a.token, payload: { password: 'errada-errada', confirm: 'EXCLUIR' } })).statusCode).toBe(401);
    expect((await env.req({ method: 'DELETE', url: '/me', token: a.token, payload: { password: PASSWORD, confirm: 'sim' } })).statusCode).toBe(400);
    expect((await env.req({ method: 'DELETE', url: '/me', token: a.token, payload: { password: PASSWORD, confirm: 'EXCLUIR' } })).statusCode).toBe(204);

    const db = env.ctx.db;
    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(a.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(a.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(a.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM messages WHERE body LIKE '%sumir%'").get()).toBeUndefined();
    expect((await env.req({ method: 'GET', url: '/me', token: a.token })).statusCode).toBe(401);

    const conv = (await env.req({ method: 'GET', url: '/conversations', token: b.token })).json().conversations[0];
    expect(conv.participant.displayName).toBe('Usuário indisponível');
  });

  it('conta suspensa excluída não pode ser recriada com o mesmo e-mail', async () => {
    const env = await setup();
    const user = await createUser(env);
    env.ctx.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    expect((await env.req({ method: 'DELETE', url: '/me', token: user.token, payload: { password: PASSWORD, confirm: 'EXCLUIR' } })).statusCode).toBe(204);
    const before = env.mailer.outbox.length;
    const res = await env.req({ method: 'POST', url: '/auth/register', payload: { email: user.email, password: PASSWORD, birthdate: '1990-01-01', displayName: 'De novo', acceptTerms: true } });
    expect(res.statusCode).toBe(202);
    expect(env.ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(user.email)).toBeUndefined();
    expect(env.mailer.outbox.length).toBe(before);
  });
});

describe('endurecimento HTTP', () => {
  it('envia cabeçalhos de segurança', async () => {
    const env = await setup();
    const res = await env.req({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS só reflete origens da lista', async () => {
    const env = await setup();
    const ok = await env.req({ method: 'GET', url: '/health', headers: { origin: 'https://app.example.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.test');
    const evil = await env.req({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('erros internos não vazam detalhes', async () => {
    const env = await setup();
    env.app.get('/__boom', async () => {
      throw new Error('SQLITE_ERROR: no such column secret_internal_detail');
    });
    const res = await env.req({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret_internal_detail');
    expect(res.json().error.requestId).toBeDefined();
  });

  it('JSON malformado e corpo grande demais são rejeitados sem stack trace', async () => {
    const env = await setup();
    const bad = await env.req({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.js/);
    const big = await env.req({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a'.repeat(70_000) }) });
    expect(big.statusCode).toBe(413);
  });

  it('ids inválidos na rota retornam 400, não erro interno (sem injeção)', async () => {
    const env = await setup();
    const a = await createUser(env);
    const res = await env.req({ method: 'GET', url: `/users/${encodeURIComponent("1' OR '1'='1")}`, token: a.token });
    expect(res.statusCode).toBe(400);
  });
});
