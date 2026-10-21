export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Autenticação necessária') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (code = 'forbidden', message = 'Ação não permitida') =>
  new AppError(403, code, message);
/**
 * Também usado quando o recurso existe mas o solicitante não pode vê-lo (bloqueio, perfil oculto,
 * conversa alheia), para não revelar a existência do recurso.
 */
export const notFound = (message = 'Não encontrado') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(429, 'rate_limited', 'Muitas tentativas. Tente novamente mais tarde.', { retryAfterSec }, {
    'retry-after': String(retryAfterSec),
  });
