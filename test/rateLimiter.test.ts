import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rateLimiter.js';
import { FakeClock } from './helpers.js';

describe('RateLimiter', () => {
  it('janela deslizante: libera conforme eventos antigos expiram', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(clock);
    const rule = { limit: 2, windowMs: 1000 };
    rl.consume('k', rule);
    clock.advance(600);
    rl.consume('k', rule);
    expect(() => rl.consume('k', rule)).toThrow();
    clock.advance(401);
    expect(() => rl.consume('k', rule)).not.toThrow();
  });

  it('descarta chaves inativas para não crescer sem limite', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(clock);
    for (let i = 0; i < 5000; i++) rl.consume(`ip:${i}`, { limit: 5, windowMs: 60_000 });
    expect(rl.size).toBe(5000);
    clock.advance(25 * 60 * 60 * 1000);
    for (let i = 0; i < 1000; i++) rl.consume('ativo', { limit: 10_000, windowMs: 60_000 });
    expect(rl.size).toBe(1);
  });
});
