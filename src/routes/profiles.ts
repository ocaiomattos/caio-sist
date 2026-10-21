import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, type Context } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { roundCoord } from '../lib/geo.js';
import { limits } from '../lib/rateLimiter.js';
import { idParam, parse } from '../lib/validation.js';
import {
  canViewProfile,
  getProfileRow,
  PROFILE_SELECT,
  serializeOwnProfile,
  serializePublicProfile,
  type ProfileRow,
} from '../services/profiles.js';

export const GENDERS = ['woman', 'man', 'non_binary', 'trans_woman', 'trans_man', 'other', 'unspecified'] as const;
export const LOOKING_FOR = ['friendship', 'dating', 'play_partner', 'relationship', 'community', 'chat'] as const;

const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40),
    bio: z.string().trim().max(1000),
    gender: z.enum(GENDERS),
    lookingFor: z.array(z.enum(LOOKING_FOR)).max(LOOKING_FOR.length),
    interests: z.array(z.string().trim().min(1).max(30)).max(20),
    city: z.string().trim().max(80),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().nullable(),
    visibility: z.enum(['members', 'hidden']),
    discoverable: z.boolean(),
    showAge: z.boolean(),
    showDistance: z.boolean(),
    allowMessagesFrom: z.enum(['everyone', 'existing_conversations']),
  })
  .partial()
  .strict();

// Mapeia campos da API para colunas. Só estes campos podem ser alterados (anti mass-assignment).
const COLUMN: Record<string, string> = {
  displayName: 'display_name',
  bio: 'bio',
  gender: 'gender',
  lookingFor: 'looking_for',
  interests: 'interests',
  city: 'city',
  visibility: 'visibility',
  discoverable: 'discoverable',
  showAge: 'show_age',
  showDistance: 'show_distance',
  allowMessagesFrom: 'allow_messages_from',
};

const INACTIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const discoverQuery = z
  .object({
    ageMin: z.coerce.number().int().min(18).max(120).optional(),
    ageMax: z.coerce.number().int().min(18).max(120).optional(),
    gender: z.enum(GENDERS).optional(),
    lookingFor: z.enum(LOOKING_FOR).optional(),
    interest: z.string().trim().min(1).max(30).optional(),
    maxDistanceKm: z.coerce.number().int().min(10).max(500).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

function encodeCursor(lastActive: number, id: string): string {
  return Buffer.from(`${lastActive}:${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { lastActive: number; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  if (!ts || !id || !/^\d+$/.test(ts)) throw badRequest('invalid_cursor', 'Cursor inválido');
  return { lastActive: Number(ts), id };
}

/** Data de nascimento correspondente a "ter exatamente `years` anos hoje". */
function birthdateYearsAgo(now: number, years: number): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function profileRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, limiter } = ctx;

  app.get('/me/profile', async (req) => {
    const user = authenticate(ctx, req, { allowUnverified: true, allowDeactivated: true });
    return serializeOwnProfile(ctx, getProfileRow(ctx, user.id)!);
  });

  app.patch('/me/profile', async (req) => {
    const user = authenticate(ctx, req, { allowUnverified: true, allowDeactivated: true });
    const body = parse(profilePatchSchema, req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (key === 'location') continue;
      const column = COLUMN[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      if (Array.isArray(value)) values.push(JSON.stringify([...new Set(value)]));
      else if (typeof value === 'boolean') values.push(value ? 1 : 0);
      else values.push(value);
    }
    if (body.location !== undefined) {
      // A posição é arredondada antes de ser persistida; a coordenada exata é descartada.
      sets.push('lat_approx = ?', 'lng_approx = ?');
      values.push(
        body.location ? roundCoord(body.location.lat) : null,
        body.location ? roundCoord(body.location.lng) : null,
      );
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(clock.now(), user.id);
      db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`).run(...values);
    }
    return serializeOwnProfile(ctx, getProfileRow(ctx, user.id)!);
  });

  app.get('/users/:id', async (req) => {
    const user = authenticate(ctx, req);
    limiter.consume(`profile-view:${user.id}`, limits.profileViewsPerUser);
    const { id } = parse(idParam, req.params);
    const target = getProfileRow(ctx, id);
    if (!canViewProfile(ctx, user.id, target)) throw notFound('Perfil não encontrado');
    return serializePublicProfile(ctx, target, getProfileRow(ctx, user.id));
  });

  app.get('/discover', async (req) => {
    const user = authenticate(ctx, req);
    limiter.consume(`discover:${user.id}`, limits.discoveryPerUser);
    const q = parse(discoverQuery, req.query);
    if (q.ageMin && q.ageMax && q.ageMin > q.ageMax) throw badRequest('validation_error', 'ageMin maior que ageMax');
    const viewer = getProfileRow(ctx, user.id)!;
    const now = clock.now();

    const where: string[] = [
      "u.status = 'active'",
      'u.email_verified_at IS NOT NULL',
      "p.visibility = 'members'",
      'p.discoverable = 1',
      'p.user_id != @me',
      'p.last_active_at > @activeSince',
      'NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = @me AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = @me))',
    ];
    const params: Record<string, unknown> = { me: user.id, activeSince: now - INACTIVE_AFTER_MS, limit: q.limit + 1 };

    if (q.ageMin) {
      where.push('u.birthdate <= @maxBirthdate');
      params.maxBirthdate = birthdateYearsAgo(now, q.ageMin);
    }
    if (q.ageMax) {
      // Quem tem ageMax anos nasceu depois de (hoje - (ageMax + 1) anos).
      where.push('u.birthdate > @minBirthdate');
      params.minBirthdate = birthdateYearsAgo(now, q.ageMax + 1);
    }
    if (q.gender) {
      where.push('p.gender = @gender');
      params.gender = q.gender;
    }
    if (q.lookingFor) {
      where.push('EXISTS (SELECT 1 FROM json_each(p.looking_for) WHERE value = @lookingFor)');
      params.lookingFor = q.lookingFor;
    }
    if (q.interest) {
      where.push('EXISTS (SELECT 1 FROM json_each(p.interests) WHERE lower(value) = lower(@interest))');
      params.interest = q.interest;
    }
    if (q.maxDistanceKm) {
      if (viewer.lat_approx === null || viewer.lng_approx === null) {
        throw badRequest('location_required', 'Defina sua localização aproximada para filtrar por distância.');
      }
      // Pré-filtro por caixa delimitadora (usa índice); a distância é refinada abaixo.
      const dLat = q.maxDistanceKm / 111;
      const dLng = q.maxDistanceKm / (111 * Math.max(0.01, Math.cos((viewer.lat_approx * Math.PI) / 180)));
      where.push('p.lat_approx BETWEEN @latMin AND @latMax AND p.lng_approx BETWEEN @lngMin AND @lngMax');
      Object.assign(params, {
        latMin: viewer.lat_approx - dLat,
        latMax: viewer.lat_approx + dLat,
        lngMin: viewer.lng_approx - dLng,
        lngMax: viewer.lng_approx + dLng,
      });
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push('(p.last_active_at < @cLast OR (p.last_active_at = @cLast AND p.user_id < @cId))');
      params.cLast = c.lastActive;
      params.cId = c.id;
    }

    const rows = db
      .prepare(`${PROFILE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.last_active_at DESC, p.user_id DESC LIMIT @limit`)
      .all(params) as ProfileRow[];
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      results: page.map((r) => serializePublicProfile(ctx, r, viewer)),
      nextCursor: hasMore && last ? encodeCursor(last.last_active_at, last.user_id) : null,
    };
  });
}
