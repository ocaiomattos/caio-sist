import { z } from 'zod';
import { badRequest } from './errors.js';

/** Valida a entrada com um schema estrito; campos desconhecidos são rejeitados (anti mass-assignment). */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw badRequest(
      'validation_error',
      'Dados inválidos',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const idParam = z.object({ id: z.string().uuid() }).strict();
