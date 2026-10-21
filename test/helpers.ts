import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Context } from '../src/context.js';
import { openDatabase } from '../src/db/index.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { MemoryStorage } from '../src/lib/storage.js';

export class FakeClock {
  constructor(public t = Date.UTC(2026, 9, 21, 12, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface TestEnv {
  app: FastifyInstance;
  ctx: Context;
  mailer: MemoryMailer;
  storage: MemoryStorage;
  clock: FakeClock;
  req: (opts: InjectOptions & { token?: string }) => Promise<LightMyRequestResponse>;
}

const open: TestEnv[] = [];
afterEach(async () => {
  while (open.length) {
    const env = open.pop()!;
    await env.app.close();
    env.ctx.db.close();
  }
});

export async function setup(): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    MEDIA_URL_SECRET: 'test-secret-test-secret-test-secret-0123',
    CORS_ORIGINS: 'https://app.example.test',
    PUBLIC_APP_URL: 'https://app.example.test',
  });
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const clock = new FakeClock();
  const { app, ctx } = await buildApp({ config, db: openDatabase(':memory:'), mailer, storage, clock, logger: false });
  const env: TestEnv = {
    app,
    ctx,
    mailer,
    storage,
    clock,
    req: ({ token, headers, ...rest }) =>
      app.inject({ ...rest, headers: { ...(headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
  };
  open.push(env);
  return env;
}

export const PASSWORD = 'correct horse battery';

export function lastTokenFor(env: TestEnv, email: string, path: string): string {
  const mail = [...env.mailer.outbox].reverse().find((m) => m.to === email && m.text.includes(path));
  if (!mail) throw new Error(`nenhum e-mail com ${path} para ${email}`);
  const m = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  return m![1]!;
}

let counter = 0;

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

/** Cria um usuário verificado e logado, opcionalmente com perfil e papel. */
export async function createUser(
  env: TestEnv,
  opts: {
    name?: string;
    birthdate?: string;
    role?: 'user' | 'moderator' | 'admin';
    profile?: Record<string, unknown>;
  } = {},
): Promise<TestUser> {
  const email = `user${++counter}@example.test`;
  const reg = await env.req({
    method: 'POST',
    url: '/auth/register',
    remoteAddress: `10.0.${counter % 250}.${(counter * 7) % 250}`,
    payload: {
      email,
      password: PASSWORD,
      birthdate: opts.birthdate ?? '1990-05-10',
      displayName: opts.name ?? `User ${counter}`,
      acceptTerms: true,
    },
  });
  if (reg.statusCode !== 202) throw new Error(`register falhou: ${reg.body}`);
  const verify = await env.req({
    method: 'POST',
    url: '/auth/verify-email',
    payload: { token: lastTokenFor(env, email, '/verify-email') },
  });
  if (verify.statusCode !== 200) throw new Error(`verify falhou: ${verify.body}`);
  const login = await env.req({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`login falhou: ${login.body}`);
  const { token, user } = login.json();
  if (opts.role) env.ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(opts.role, user.id);
  if (opts.profile) {
    const res = await env.req({ method: 'PATCH', url: '/me/profile', token, payload: opts.profile });
    if (res.statusCode !== 200) throw new Error(`profile falhou: ${res.body}`);
  }
  return { id: user.id, email, token };
}
