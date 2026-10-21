import type { Clock } from './clock.js';
import { tooManyRequests } from './errors.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_WINDOW_MS = DAY;

export interface RateLimitRule {
  /** Número máximo de eventos na janela. */
  limit: number;
  windowMs: number;
}

/**
 * Limitador de janela deslizante em memória. Adequado a uma única instância; com várias
 * instâncias, substitua o armazenamento por Redis mantendo esta interface (ver docs/ARCHITECTURE.md).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private ops = 0;

  constructor(private readonly clock: Clock) {}

  /** Quantidade de chaves em memória (usado em testes e métricas). */
  get size(): number {
    return this.hits.size;
  }

  /** Registra um evento e lança 429 se o limite da chave for excedido. */
  consume(key: string, rule: RateLimitRule): void {
    const retry = this.check(key, rule, true);
    if (retry !== null) throw tooManyRequests(retry);
  }

  /** Lança 429 se a chave já atingiu o limite, sem registrar um novo evento. */
  assertNotLimited(key: string, rule: RateLimitRule): void {
    const retry = this.check(key, rule, false);
    if (retry !== null) throw tooManyRequests(retry);
  }

  /** Registra um evento sem verificar (ex.: falha de login contabilizada após a verificação). */
  record(key: string, rule: RateLimitRule): void {
    const list = this.prune(key, rule);
    list.push(this.clock.now());
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private check(key: string, rule: RateLimitRule, record: boolean): number | null {
    const now = this.clock.now();
    const list = this.prune(key, rule);
    if (list.length >= rule.limit) {
      const oldest = list[0]!;
      return Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
    }
    if (record) {
      list.push(now);
      this.hits.set(key, list);
    }
    return null;
  }

  /**
   * Remove periodicamente chaves sem eventos no último dia (maior janela usada), para que a
   * rotação de IPs ou e-mails não faça a memória crescer sem limite.
   */
  private sweep(): void {
    if (++this.ops % 1000 !== 0) return;
    const cutoff = this.clock.now() - MAX_WINDOW_MS;
    for (const [key, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1]! <= cutoff) this.hits.delete(key);
    }
  }

  private prune(key: string, rule: RateLimitRule): number[] {
    this.sweep();
    const cutoff = this.clock.now() - rule.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    return list;
  }
}


/** Limites centralizados para facilitar revisão e ajuste. */
export const limits = {
  registerPerIp: { limit: 5, windowMs: HOUR },
  loginFailuresPerAccount: { limit: 10, windowMs: 15 * MIN },
  loginPerIp: { limit: 50, windowMs: 15 * MIN },
  passwordResetPerEmail: { limit: 3, windowMs: HOUR },
  passwordResetPerIp: { limit: 20, windowMs: HOUR },
  verificationResendPerEmail: { limit: 3, windowMs: HOUR },
  profileViewsPerUser: { limit: 300, windowMs: HOUR },
  discoveryPerUser: { limit: 60, windowMs: MIN },
  messagesPerUser: { limit: 30, windowMs: MIN },
  newConversationsPerUser: { limit: 20, windowMs: DAY },
  uploadsPerUser: { limit: 30, windowMs: HOUR },
  reportsPerUser: { limit: 20, windowMs: DAY },
} satisfies Record<string, RateLimitRule>;
