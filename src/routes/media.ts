import type { FastifyInstance } from 'fastify';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { audit, authenticate, type Context, isBlockedEitherWay } from '../context.js';
import { hmac, newId, safeEqual } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { limits } from '../lib/rateLimiter.js';
import { idParam, parse } from '../lib/validation.js';
import { canViewProfile, getProfileRow, hasPrivateAccess } from '../services/profiles.js';

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
/** Rejeita "bombas de descompressão" (imagens pequenas em bytes e enormes em pixels). */
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_DIMENSION = 2048;

interface PhotoRow {
  id: string;
  owner_id: string;
  storage_key: string;
  visibility: 'public' | 'private';
  mime: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
}

const serializePhoto = (p: PhotoRow) => ({
  id: p.id,
  visibility: p.visibility,
  width: p.width,
  height: p.height,
  bytes: p.bytes,
  createdAt: p.created_at,
});

/**
 * Decodifica e re-codifica a imagem. Isso valida o conteúdo real (não a extensão nem o Content-Type
 * informado pelo cliente) e descarta todos os metadados, incluindo EXIF/GPS.
 */
export async function sanitizeImage(input: Buffer) {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw new AppError(415, 'unsupported_media_type', 'Arquivo não é uma imagem válida (aceitos: JPEG, PNG, WebP).');
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new AppError(415, 'unsupported_media_type', 'Formato não suportado (aceitos: JPEG, PNG, WebP).');
  }
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // aplica a orientação EXIF antes de descartar os metadados
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, mime: 'image/jpeg' };
  } catch {
    throw new AppError(415, 'unsupported_media_type', 'Não foi possível processar a imagem.');
  }
}

export function signFileUrl(ctx: Context, photoId: string, expiresAt: number): string {
  const sig = hmac(ctx.config.mediaUrlSecret, `${photoId}.${expiresAt}`);
  return `/files/${photoId}?exp=${expiresAt}&sig=${sig}`;
}

export function mediaRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, limiter, storage, config } = ctx;

  const ownPhoto = (photoId: string, ownerId: string): PhotoRow => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ? AND owner_id = ?').get(photoId, ownerId) as PhotoRow | undefined;
    if (!p) throw notFound('Foto não encontrada');
    return p;
  };

  app.post('/me/photos', async (req, reply) => {
    const user = authenticate(ctx, req);
    const { visibility } = parse(
      z.object({ visibility: z.enum(['public', 'private']).default('public') }).strict(),
      req.query,
    );
    limiter.consume(`upload:${user.id}`, limits.uploadsPerUser);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner_id = ?').get(user.id) as { n: number };
    if (n >= config.maxPhotosPerUser) {
      throw conflict('photo_limit', `Limite de ${config.maxPhotosPerUser} fotos atingido. Exclua uma para enviar outra.`);
    }

    if (!req.isMultipart()) throw badRequest('multipart_required', 'Envie a imagem como multipart/form-data');
    const file = await req.file();
    if (!file) throw badRequest('file_required', 'Nenhum arquivo enviado');
    const raw = await file.toBuffer(); // excede o limite → 413 (ver tratamento de erros em app.ts)
    const image = await sanitizeImage(raw);

    const id = newId();
    const key = `${newId()}.jpg`;
    await storage.put(key, image.data);
    try {
      db.prepare(
        'INSERT INTO photos (id, owner_id, storage_key, visibility, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, user.id, key, visibility, image.mime, image.width, image.height, image.data.length, clock.now());
    } catch (err) {
      await storage.delete(key); // não deixa arquivo órfão
      throw err;
    }
    return reply.code(201).send(serializePhoto(ownPhoto(id, user.id)));
  });

  app.get('/me/photos', async (req) => {
    const user = authenticate(ctx, req, { allowDeactivated: true, allowSuspended: true });
    const rows = db.prepare('SELECT * FROM photos WHERE owner_id = ? ORDER BY created_at').all(user.id) as PhotoRow[];
    return { photos: rows.map(serializePhoto) };
  });

  app.patch('/me/photos/:id', async (req) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const { visibility } = parse(z.object({ visibility: z.enum(['public', 'private']) }).strict(), req.body);
    ownPhoto(id, user.id);
    db.prepare('UPDATE photos SET visibility = ? WHERE id = ? AND owner_id = ?').run(visibility, id, user.id);
    return serializePhoto(ownPhoto(id, user.id));
  });

  app.delete('/me/photos/:id', async (req, reply) => {
    const user = authenticate(ctx, req, { allowDeactivated: true, allowSuspended: true });
    const { id } = parse(idParam, req.params);
    const photo = ownPhoto(id, user.id);
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    await storage.delete(photo.storage_key);
    return reply.code(204).send();
  });

  /** Gera uma URL assinada de curta duração, após verificar no servidor se o solicitante pode ver a foto. */
  app.get('/photos/:id/url', async (req) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
    if (!photo) throw notFound('Foto não encontrada');
    const owner = getProfileRow(ctx, photo.owner_id);
    const allowed =
      canViewProfile(ctx, user.id, owner) &&
      (photo.visibility === 'public' || hasPrivateAccess(ctx, photo.owner_id, user.id));
    if (!allowed) throw notFound('Foto não encontrada');
    const expiresAt = clock.now() + config.signedUrlTtlMs;
    return { url: signFileUrl(ctx, photo.id, expiresAt), expiresAt };
  });

  app.get('/files/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }).strict(), req.query);
    const now = clock.now();
    const expected = hmac(config.mediaUrlSecret, `${id}.${q.exp}`);
    if (!safeEqual(expected, q.sig) || q.exp <= now) throw notFound();
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
    if (!photo) throw notFound();
    const data = await storage.get(photo.storage_key);
    if (!data) throw notFound();
    return reply
      .header('content-type', photo.mime)
      .header('cache-control', `private, max-age=${Math.floor((q.exp - now) / 1000)}`)
      .header('content-disposition', 'inline')
      .send(data);
  });

  // Acesso a fotos privadas, concedido e revogado pelo dono.
  app.get('/me/private-access', async (req) => {
    const user = authenticate(ctx, req);
    const rows = db
      .prepare(
        `SELECT g.grantee_id, g.created_at, p.display_name FROM private_access_grants g
         LEFT JOIN profiles p ON p.user_id = g.grantee_id WHERE g.owner_id = ? ORDER BY g.created_at DESC`,
      )
      .all(user.id) as Array<{ grantee_id: string; created_at: number; display_name: string | null }>;
    return { grants: rows.map((r) => ({ userId: r.grantee_id, displayName: r.display_name, createdAt: r.created_at })) };
  });

  app.post('/me/private-access', async (req, reply) => {
    const user = authenticate(ctx, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }).strict(), req.body);
    if (userId === user.id || isBlockedEitherWay(ctx, user.id, userId) || !canViewProfile(ctx, user.id, getProfileRow(ctx, userId))) {
      throw notFound('Perfil não encontrado');
    }
    db.prepare('INSERT OR IGNORE INTO private_access_grants (owner_id, grantee_id, created_at) VALUES (?, ?, ?)').run(
      user.id,
      userId,
      clock.now(),
    );
    audit(ctx, 'private_access_granted', user.id, userId);
    return reply.code(204).send();
  });

  app.delete('/me/private-access/:id', async (req, reply) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const res = db.prepare('DELETE FROM private_access_grants WHERE owner_id = ? AND grantee_id = ?').run(user.id, id);
    if (res.changes === 0) throw notFound();
    audit(ctx, 'private_access_revoked', user.id, id);
    return reply.code(204).send();
  });
}
