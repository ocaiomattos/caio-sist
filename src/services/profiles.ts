import type { Context } from '../context.js';
import { isBlockedEitherWay } from '../context.js';
import { ageFromBirthdate, distanceBucket, haversineKm } from '../lib/geo.js';

export interface ProfileRow {
  user_id: string;
  display_name: string;
  bio: string;
  gender: string;
  looking_for: string;
  interests: string;
  city: string;
  lat_approx: number | null;
  lng_approx: number | null;
  visibility: 'members' | 'hidden';
  discoverable: number;
  show_age: number;
  show_distance: number;
  allow_messages_from: 'everyone' | 'existing_conversations';
  last_active_at: number;
  birthdate: string;
  status: string;
  email_verified_at: number | null;
}

export const PROFILE_SELECT = `
  SELECT p.*, u.birthdate, u.status, u.email_verified_at
  FROM profiles p JOIN users u ON u.id = p.user_id`;

const DAY = 24 * 60 * 60 * 1000;

/** Atividade exibida em faixas: horário exato permitiria monitorar a rotina de alguém. */
export function activityBucket(lastActive: number, now: number): string {
  const diff = now - lastActive;
  if (diff < DAY) return 'ativo hoje';
  if (diff < 7 * DAY) return 'ativo nesta semana';
  if (diff < 30 * DAY) return 'ativo neste mês';
  return 'ativo há mais de um mês';
}

export function getProfileRow(ctx: Context, userId: string): ProfileRow | undefined {
  return ctx.db.prepare(`${PROFILE_SELECT} WHERE p.user_id = ?`).get(userId) as ProfileRow | undefined;
}

export function haveConversation(ctx: Context, a: string, b: string): boolean {
  const [x, y] = a < b ? [a, b] : [b, a];
  return ctx.db.prepare('SELECT 1 FROM conversations WHERE user_a = ? AND user_b = ?').get(x, y) !== undefined;
}

export function hasPrivateAccess(ctx: Context, ownerId: string, viewerId: string): boolean {
  return (
    ownerId === viewerId ||
    ctx.db.prepare('SELECT 1 FROM private_access_grants WHERE owner_id = ? AND grantee_id = ?').get(ownerId, viewerId) !==
      undefined
  );
}

/**
 * Regra única de visibilidade de perfil para terceiros. Retorna false para: conta inexistente,
 * não ativa, e-mail não verificado, bloqueio em qualquer direção, ou perfil oculto sem conversa prévia.
 */
export function canViewProfile(ctx: Context, viewerId: string, target: ProfileRow | undefined): target is ProfileRow {
  if (!target) return false;
  if (target.user_id === viewerId) return true;
  if (target.status !== 'active' || target.email_verified_at === null) return false;
  if (isBlockedEitherWay(ctx, viewerId, target.user_id)) return false;
  if (target.visibility === 'hidden' && !haveConversation(ctx, viewerId, target.user_id)) return false;
  return true;
}

interface PhotoRow {
  id: string;
  visibility: 'public' | 'private';
  width: number;
  height: number;
  created_at: number;
}

/** Representação pública do perfil. Nunca inclui e-mail, data de nascimento ou coordenadas. */
export function serializePublicProfile(ctx: Context, row: ProfileRow, viewer: ProfileRow | undefined) {
  const now = ctx.clock.now();
  const viewerId = viewer?.user_id ?? '';
  const photos = ctx.db
    .prepare('SELECT id, visibility, width, height, created_at FROM photos WHERE owner_id = ? ORDER BY created_at')
    .all(row.user_id) as PhotoRow[];
  const privateAccess = hasPrivateAccess(ctx, row.user_id, viewerId);

  let distance: string | null = null;
  if (
    row.show_distance &&
    viewer &&
    viewer.user_id !== row.user_id &&
    row.lat_approx !== null &&
    row.lng_approx !== null &&
    viewer.lat_approx !== null &&
    viewer.lng_approx !== null
  ) {
    distance = distanceBucket(haversineKm(viewer.lat_approx, viewer.lng_approx, row.lat_approx, row.lng_approx));
  }

  return {
    id: row.user_id,
    displayName: row.display_name,
    bio: row.bio,
    gender: row.gender,
    lookingFor: JSON.parse(row.looking_for) as string[],
    interests: JSON.parse(row.interests) as string[],
    city: row.city,
    age: row.show_age ? ageFromBirthdate(row.birthdate, now) : null,
    distance,
    activity: activityBucket(row.last_active_at, now),
    photos: photos
      .filter((p) => p.visibility === 'public' || privateAccess)
      .map((p) => ({ id: p.id, visibility: p.visibility, width: p.width, height: p.height })),
    privatePhotoCount: photos.filter((p) => p.visibility === 'private').length,
    hasPrivateAccess: privateAccess,
  };
}

/** Representação completa para o próprio dono, incluindo configurações de privacidade. */
export function serializeOwnProfile(ctx: Context, row: ProfileRow) {
  return {
    ...serializePublicProfile(ctx, row, row),
    location: row.lat_approx !== null ? { latApprox: row.lat_approx, lngApprox: row.lng_approx } : null,
    settings: {
      visibility: row.visibility,
      discoverable: row.discoverable === 1,
      showAge: row.show_age === 1,
      showDistance: row.show_distance === 1,
      allowMessagesFrom: row.allow_messages_from,
    },
  };
}
