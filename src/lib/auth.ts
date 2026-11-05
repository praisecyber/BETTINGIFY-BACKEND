import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { get, newId, nowIso, run } from '../db.js';
import { forbidden, unauthorized } from './errors.js';

export interface AuthUser { id: string; role: 'user' | 'admin' }
declare module 'express-serve-static-core' { interface Request { user?: AuthUser } }

export const hashPassword = (pw: string) => bcrypt.hash(pw, config.bcryptCost);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export const signAccess = (u: AuthUser) =>
  jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { expiresIn: config.accessTtlSec });

export function verifyAccess(token: string): AuthUser | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (!p.sub) return null;
    const u = get<{ id: string; role: 'user' | 'admin'; status: string }>('SELECT id, role, status FROM users WHERE id = ?', p.sub);
    if (!u || u.status !== 'active') return null;
    return { id: u.id, role: u.role };
  } catch { return null; }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function issueRefreshToken(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.refreshTtlDays * 86_400_000).toISOString();
  run('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)',
    newId('rt'), userId, sha(token), expires, nowIso());
  return token;
}

/** rotates: the presented token is revoked and a new one is issued */
export function rotateRefreshToken(token: string) {
  const row = get<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    'SELECT * FROM refresh_tokens WHERE token_hash = ?', sha(token));
  if (!row || row.revoked_at || row.expires_at < nowIso()) {
    if (row?.revoked_at) run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), row.user_id); // reuse detected
    throw unauthorized('Invalid refresh token');
  }
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
  return { userId: row.user_id, refreshToken: issueRefreshToken(row.user_id) };
}

export const revokeRefreshToken = (token: string) =>
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', nowIso(), sha(token));

export const requireAuth: RequestHandler = (req, _res, next) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(unauthorized());
  const u = verifyAccess(h.slice(7));
  if (!u) return next(unauthorized('Invalid or expired token'));
  req.user = u;
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) =>
  req.user?.role === 'admin' ? next() : next(forbidden('Admin only'));
