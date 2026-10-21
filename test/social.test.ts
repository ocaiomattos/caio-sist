import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createUser, setup, type TestEnv, type TestUser } from './helpers.js';

const send = (env: TestEnv, from: TestUser, to: TestUser, body: string, clientId?: string) =>
  env.req({ method: 'POST', url: '/messages', token: from.token, payload: { recipientId: to.id, body, ...(clientId ? { clientId } : {}) } });

describe('perfil: privacidade e mass assignment', () => {
  it('resposta pública não expõe e-mail, data de nascimento nem coordenadas', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env, { profile: { location: { lat: -23.561684, lng: -46.655981 }, city: 'São Paulo' } });
    const res = await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain(b.email);
    expect(text).not.toContain('1990-05-10');
    expect(text).not.toContain('-23.5');
    expect(res.json()).not.toHaveProperty('location');
    expect(res.json().age).toBe(36);
  });

  it('a localização é arredondada antes de ser gravada', async () => {
    const env = await setup();
    const a = await createUser(env, { profile: { location: { lat: -23.561684, lng: -46.655981 } } });
    const row = env.ctx.db.prepare('SELECT lat_approx, lng_approx FROM profiles WHERE user_id = ?').get(a.id) as { lat_approx: number; lng_approx: number };
    expect(row.lat_approx).toBeCloseTo(-23.55, 5);
    expect(row.lng_approx).toBeCloseTo(-46.65, 5);
  });

  it('PATCH rejeita campos não permitidos (role, status, email, user_id)', async () => {
    const env = await setup();
    const a = await createUser(env);
    for (const payload of [{ role: 'admin' }, { status: 'active' }, { email: 'x@y.z' }, { user_id: 'x' }, { birthdate: '2010-01-01' }]) {
      const res = await env.req({ method: 'PATCH', url: '/me/profile', token: a.token, payload });
      expect(res.statusCode).toBe(400);
    }
    const role = env.ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(a.id) as { role: string };
    expect(role.role).toBe('user');
  });

  it('perfil oculto não é visível a quem não tem conversa prévia', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const c = await createUser(env);
    await send(env, b, c, 'oi');
    await env.req({ method: 'PATCH', url: '/me/profile', token: c.token, payload: { visibility: 'hidden' } });
    expect((await env.req({ method: 'GET', url: `/users/${c.id}`, token: a.token })).statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: `/users/${c.id}`, token: b.token })).statusCode).toBe(200);
  });

  it('atividade é exibida em faixas, sem horário exato', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const res = (await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token })).json();
    expect(res.activity).toBe('ativo hoje');
    expect(JSON.stringify(res)).not.toMatch(/last_active|lastActiveAt/);
  });

  it('limita visualizações de perfil por hora (anti-scraping)', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    for (let i = 0; i < 300; i++) await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token });
    expect((await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token })).statusCode).toBe(429);
  });
});

describe('bloqueio', () => {
  it('bloqueio é imposto pelo servidor nas duas direções', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await send(env, a, b, 'oi');
    const conv = (await env.req({ method: 'GET', url: '/conversations', token: b.token })).json().conversations[0].id;
    expect((await env.req({ method: 'POST', url: '/blocks', token: b.token, payload: { userId: a.id } })).statusCode).toBe(204);

    // Quem foi bloqueado não vê o perfil, não envia mensagem, não lê a conversa e não acha na descoberta.
    expect((await env.req({ method: 'GET', url: `/users/${b.id}`, token: a.token })).statusCode).toBe(404);
    const msg = await send(env, a, b, 'ainda aí?');
    expect(msg.statusCode).toBe(404);
    expect(msg.json().error.code).toBe('not_found'); // indistinguível de perfil inexistente
    expect((await env.req({ method: 'GET', url: `/conversations/${conv}/messages`, token: a.token })).statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: '/conversations', token: a.token })).json().conversations).toHaveLength(0);
    const disc = (await env.req({ method: 'GET', url: '/discover', token: a.token })).json();
    expect(disc.results.map((r: { id: string }) => r.id)).not.toContain(b.id);

    // E quem bloqueou também não envia nem vê.
    expect((await send(env, b, a, 'tchau')).statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: `/users/${a.id}`, token: b.token })).statusCode).toBe(404);
  });

  it('bloquear revoga acesso a fotos privadas nas duas direções', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await env.req({ method: 'POST', url: '/me/private-access', token: a.token, payload: { userId: b.id } });
    await env.req({ method: 'POST', url: '/me/private-access', token: b.token, payload: { userId: a.id } });
    await env.req({ method: 'POST', url: '/blocks', token: a.token, payload: { userId: b.id } });
    const { n } = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM private_access_grants').get() as { n: number };
    expect(n).toBe(0);
  });

  it('desbloquear restaura a visibilidade; não é possível bloquear a si mesmo', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    expect((await env.req({ method: 'POST', url: '/blocks', token: a.token, payload: { userId: a.id } })).statusCode).toBe(400);
    await env.req({ method: 'POST', url: '/blocks', token: a.token, payload: { userId: b.id } });
    expect((await env.req({ method: 'GET', url: '/blocks', token: a.token })).json().blocks).toHaveLength(1);
    expect((await env.req({ method: 'DELETE', url: `/blocks/${b.id}`, token: a.token })).statusCode).toBe(204);
    expect((await env.req({ method: 'GET', url: `/users/${a.id}`, token: b.token })).statusCode).toBe(200);
  });
});

describe('mensagens', () => {
  it('terceiros não leem nem marcam como lidas conversas alheias (IDOR/BOLA)', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const intruder = await createUser(env);
    await send(env, a, b, 'segredo');
    const conv = (await env.req({ method: 'GET', url: '/conversations', token: a.token })).json().conversations[0].id;
    const read = await env.req({ method: 'GET', url: `/conversations/${conv}/messages`, token: intruder.token });
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain('segredo');
    const mark = await env.req({ method: 'POST', url: `/conversations/${conv}/read`, token: intruder.token, payload: { upToSeq: 999 } });
    expect(mark.statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: '/conversations', token: intruder.token })).json().conversations).toHaveLength(0);
  });

  it('reenvio com o mesmo clientId não duplica a mensagem (idempotência)', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const clientId = randomUUID();
    const first = await send(env, a, b, 'olá', clientId);
    const retry = await send(env, a, b, 'olá', clientId);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);
    expect(retry.json().message.id).toBe(first.json().message.id);
    const { n } = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(n).toBe(1);
  });

  it('limita mensagens antes da primeira resposta', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    for (let i = 0; i < 3; i++) expect((await send(env, a, b, `msg ${i}`)).statusCode).toBe(201);
    const fourth = await send(env, a, b, 'msg 4');
    expect(fourth.statusCode).toBe(403);
    expect(fourth.json().error.code).toBe('awaiting_reply');
    expect((await send(env, b, a, 'oi!')).statusCode).toBe(201);
    expect((await send(env, a, b, 'msg 4')).statusCode).toBe(201);
  });

  it('respeita a configuração "somente conversas existentes"', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env, { profile: { allowMessagesFrom: 'existing_conversations' } });
    const res = await send(env, a, b, 'oi');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('recipient_not_accepting');
  });

  it('limita novas conversas por dia', async () => {
    const env = await setup();
    const spammer = await createUser(env);
    const targets = [];
    for (let i = 0; i < 21; i++) targets.push(await createUser(env));
    for (let i = 0; i < 20; i++) {
      env.clock.advance(5000); // evita o limite por minuto
      expect((await send(env, spammer, targets[i]!, 'oi')).statusCode).toBe(201);
    }
    expect((await send(env, spammer, targets[20]!, 'oi')).statusCode).toBe(429);
  });

  it('sincronização incremental por seq e marcação de leitura', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await send(env, a, b, 'um');
    await send(env, b, a, 'dois');
    const conv = (await env.req({ method: 'GET', url: '/conversations', token: a.token })).json().conversations[0];
    expect(conv.unread).toBe(1);
    const all = (await env.req({ method: 'GET', url: `/conversations/${conv.id}/messages`, token: a.token })).json().messages;
    expect(all.map((m: { body: string }) => m.body)).toEqual(['um', 'dois']);
    await send(env, b, a, 'três');
    const delta = (await env.req({ method: 'GET', url: `/conversations/${conv.id}/messages?after=${all[1].seq}`, token: a.token })).json().messages;
    expect(delta.map((m: { body: string }) => m.body)).toEqual(['três']);
    await env.req({ method: 'POST', url: `/conversations/${conv.id}/read`, token: a.token, payload: { upToSeq: delta[0].seq } });
    expect((await env.req({ method: 'GET', url: '/conversations', token: a.token })).json().conversations[0].unread).toBe(0);
  });

  it('não envia para conta suspensa, desativada ou inexistente', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    await env.req({ method: 'POST', url: '/me/deactivate', token: b.token });
    expect((await send(env, a, b, 'oi')).statusCode).toBe(404);
    const ghost = { id: randomUUID(), email: '', token: '' };
    expect((await send(env, a, ghost, 'oi')).statusCode).toBe(404);
  });
});

describe('descoberta', () => {
  it('filtra por idade, gênero, interesse, distância e pagina com cursor', async () => {
    const env = await setup();
    const sp = { lat: -23.55, lng: -46.63 };
    const me = await createUser(env, { profile: { location: sp } });
    const near = await createUser(env, { birthdate: '1995-01-01', profile: { gender: 'woman', interests: ['Shibari'], location: sp } });
    await createUser(env, { birthdate: '1970-01-01', profile: { gender: 'woman', location: sp } });
    await createUser(env, { birthdate: '1995-01-01', profile: { gender: 'man', location: sp } });
    await createUser(env, { birthdate: '1995-01-01', profile: { gender: 'woman', location: { lat: -22.9, lng: -43.2 } } }); // Rio
    await createUser(env, { profile: { discoverable: false } });

    const q = (qs: string) => env.req({ method: 'GET', url: `/discover?${qs}`, token: me.token });
    const filtered = (await q('ageMin=25&ageMax=40&gender=woman&maxDistanceKm=50')).json();
    expect(filtered.results.map((r: { id: string }) => r.id)).toEqual([near.id]);
    expect(filtered.results[0].distance).toBe('até 10 km');
    expect((await q('interest=shibari')).json().results.map((r: { id: string }) => r.id)).toEqual([near.id]);

    const page1 = (await q('limit=2')).json();
    expect(page1.results).toHaveLength(2);
    const page2 = (await q(`limit=2&cursor=${page1.nextCursor}`)).json();
    const ids = [...page1.results, ...page2.results].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(4); // sem repetição; exclui o próprio usuário e o não-descobrível
    expect(page2.nextCursor).toBeNull();
  });

  it('exclui perfis inativos há mais de 90 dias', async () => {
    const env = await setup();
    const old = await createUser(env);
    env.clock.advance(91 * 24 * 60 * 60 * 1000);
    const me = await createUser(env);
    const ids = (await env.req({ method: 'GET', url: '/discover', token: me.token })).json().results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(old.id);
  });

  it('exige localização própria para filtrar por distância', async () => {
    const env = await setup();
    const me = await createUser(env);
    const res = await env.req({ method: 'GET', url: '/discover?maxDistanceKm=50', token: me.token });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('location_required');
  });
});
