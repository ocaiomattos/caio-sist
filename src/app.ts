import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';
import type { Context } from './context.js';
import type { DB } from './db/index.js';
import { type Clock, systemClock } from './lib/clock.js';
import { AppError } from './lib/errors.js';
import type { Mailer } from './lib/mailer.js';
import { RateLimiter } from './lib/rateLimiter.js';
import type { MediaStorage } from './lib/storage.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { blockRoutes } from './routes/blocks.js';
import { mediaRoutes } from './routes/media.js';
import { messageRoutes } from './routes/messages.js';
import { moderationRoutes } from './routes/moderation.js';
import { profileRoutes } from './routes/profiles.js';

export interface BuildOptions {
  config: AppConfig;
  db: DB;
  mailer: Mailer;
  storage: MediaStorage;
  clock?: Clock;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Context }> {
  const clock = opts.clock ?? systemClock;
  const ctx: Context = {
    config: opts.config,
    db: opts.db,
    clock,
    mailer: opts.mailer,
    storage: opts.storage,
    limiter: new RateLimiter(clock),
  };

  const app = Fastify({
    trustProxy: opts.config.trustProxy,
    bodyLimit: 64 * 1024,
    logger: opts.logger ?? {
      level: opts.config.env === 'production' ? 'info' : 'debug',
      // Nunca registrar credenciais, tokens ou corpo de requisições.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
      },
    },
  });

  await app.register(helmet, {
    // API JSON: nenhuma origem de conteúdo é necessária.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: opts.config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Requisições sem Origin (apps móveis, curl) não estão sujeitas a CORS.
      if (!origin) return cb(null, true);
      cb(null, opts.config.corsOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    credentials: false,
    maxAge: 600,
  });
  await app.register(multipart, {
    limits: { fileSize: opts.config.maxUploadBytes, files: 1, fields: 5, parts: 6 },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) {
      return reply.code(413).send({ error: { code: 'payload_too_large', message: 'Arquivo ou requisição grande demais' } });
    }
    if (e.statusCode === 415 || e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({ error: { code: 'unsupported_media_type', message: 'Tipo de conteúdo não suportado' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: 'Requisição inválida' } });
    }
    // Erro inesperado: detalhes vão para o log (sem corpo da requisição); o cliente recebe só o id.
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Erro interno', requestId: req.id } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Rota não encontrada' } }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  profileRoutes(app, ctx);
  blockRoutes(app, ctx);
  messageRoutes(app, ctx);
  mediaRoutes(app, ctx);
  moderationRoutes(app, ctx);

  return { app, ctx };
}
