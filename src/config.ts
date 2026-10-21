import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./var/app.db'),
  MEDIA_DIR: z.string().default('./var/media'),
  MEDIA_URL_SECRET: z.string().optional(),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: boolFromEnv,
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databasePath: string;
  mediaDir: string;
  mediaUrlSecret: string;
  publicAppUrl: string;
  corsOrigins: string[];
  trustProxy: boolean;
  /** Tempo de vida absoluto da sessão. */
  sessionTtlMs: number;
  /** Sessão expira se ficar sem uso por este período. */
  sessionIdleMs: number;
  passwordResetTtlMs: number;
  emailVerificationTtlMs: number;
  maxUploadBytes: number;
  maxPhotosPerUser: number;
  signedUrlTtlMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';

  let secret = parsed.MEDIA_URL_SECRET ?? '';
  if (secret.length < 32) {
    if (isProd) {
      // Falha rápida: sem segredo forte, URLs de mídia privada poderiam ser forjadas.
      throw new Error('MEDIA_URL_SECRET deve ter pelo menos 32 caracteres em produção');
    }
    secret = 'dev-only-insecure-media-secret-change-me-0000';
  }

  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    databasePath: parsed.DATABASE_PATH,
    mediaDir: parsed.MEDIA_DIR,
    mediaUrlSecret: secret,
    publicAppUrl: parsed.PUBLIC_APP_URL.replace(/\/$/, ''),
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: parsed.TRUST_PROXY,
    sessionTtlMs: 30 * DAY,
    sessionIdleMs: 14 * DAY,
    passwordResetTtlMs: 30 * 60 * 1000,
    emailVerificationTtlMs: 2 * DAY,
    maxUploadBytes: 10 * 1024 * 1024,
    maxPhotosPerUser: 12,
    signedUrlTtlMs: 5 * 60 * 1000,
  };
}
