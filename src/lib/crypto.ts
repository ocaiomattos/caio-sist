import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Token opaco de 256 bits, seguro para URL. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Tokens são armazenados apenas como hash: um vazamento do banco não permite reutilizá-los. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
