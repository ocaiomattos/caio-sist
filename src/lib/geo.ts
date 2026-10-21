/** ~0,05° ≈ 5,5 km na latitude. Impede trilateração da posição exata a partir de distâncias. */
const GRID = 0.05;

export function roundCoord(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Distância exibida somente em faixas, nunca em valor exato. */
export function distanceBucket(km: number): string {
  if (km < 10) return 'até 10 km';
  if (km < 25) return 'até 25 km';
  if (km < 50) return 'até 50 km';
  if (km < 100) return 'até 100 km';
  return 'mais de 100 km';
}

export function ageFromBirthdate(birthdate: string, now: number): number {
  const [y, m, d] = birthdate.split('-').map(Number) as [number, number, number];
  const today = new Date(now);
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age;
}
