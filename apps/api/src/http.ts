import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, 'NOT_FOUND', `${what} não encontrado.`);
export const forbidden = (msg = 'Ação não permitida.') => new HttpError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string, code = 'BAD_REQUEST') => new HttpError(400, code, msg);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw r.error;
  return r.data;
}

export function formatError(err: unknown): { status: number; body: { code: string; message: string; issues?: unknown } } {
  if (err instanceof HttpError) return { status: err.status, body: { code: err.code, message: err.message } };
  if (err instanceof ZodError) {
    return { status: 400, body: { code: 'VALIDATION', message: 'Dados inválidos.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
  }
  return { status: 500, body: { code: 'INTERNAL', message: 'Erro interno.' } };
}
