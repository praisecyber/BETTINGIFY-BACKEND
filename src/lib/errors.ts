import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);

/** wrap async handlers so rejections reach the error middleware (Express 4) */
export const ah = (fn: (...a: Parameters<RequestHandler>) => unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
