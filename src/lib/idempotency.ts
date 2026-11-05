import type { RequestHandler } from 'express';
import { get, nowIso, run } from '../db.js';
import { badRequest } from './errors.js';

/**
 * Optional `Idempotency-Key` header for money-moving POSTs. A repeated key from the same user
 * replays the stored response instead of executing again (protects against double taps / retries).
 */
export const idempotent: RequestHandler = (req, res, next) => {
  const key = req.header('Idempotency-Key');
  if (!key || !req.user) return next();
  if (key.length > 100) return next(badRequest('BAD_IDEMPOTENCY_KEY', 'Idempotency-Key too long'));
  const route = `${req.method} ${req.baseUrl}${req.path}`;
  const prev = get<{ route: string; status_code: number; response: string }>(
    'SELECT route, status_code, response FROM idempotency_keys WHERE user_id = ? AND key = ?', req.user.id, key);
  if (prev) {
    if (prev.route !== route) return next(badRequest('IDEMPOTENCY_KEY_REUSED', 'Key already used for a different endpoint'));
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(prev.status_code).type('json').send(prev.response);
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 500) {
      try {
        run('INSERT OR IGNORE INTO idempotency_keys (user_id, key, route, status_code, response, created_at) VALUES (?,?,?,?,?,?)',
          req.user!.id, key, route, res.statusCode, JSON.stringify(body), nowIso());
      } catch { /* best effort */ }
    }
    return json(body);
  };
  next();
};
