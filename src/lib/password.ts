import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt com N=2^17, r=8, p=1 (parâmetros mínimos recomendados pelo OWASP Password Storage Cheat Sheet).
// Nos testes automatizados o custo é reduzido só para acelerar a suíte; o custo fica gravado no hash.
const N = process.env.NODE_ENV === 'test' ? 2 ** 14 : 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/**
 * Executa uma verificação de custo equivalente quando o usuário não existe, para que o tempo de
 * resposta não revele quais e-mails estão cadastrados.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
}
