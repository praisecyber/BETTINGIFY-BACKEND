import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { get, newId, nowIso, run, tx } from '../db.js';
import { ah, AppError, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { checkPassword, dummyPasswordHash, hashPassword, issueRefreshToken, requireAuth, revokeRefreshToken, rotateRefreshToken, signAccess } from '../lib/auth.js';
import { ensureWallet, grantBonus } from '../services/wallet.js';
import { consumeAccountToken, isOldEnough, issueAccountToken } from '../services/account.js';
import { userDto, type UserRow } from './me.js';

export const authRouter = Router();
const phone = z.string().transform((s) => s.replace(/[\s\-()]/g, '')).refine((s) => /^\+?[0-9]{7,15}$/.test(s), 'Invalid phone number');

const registerSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  phone,
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acceptedTerms: z.literal(true, { message: 'You must accept the terms and confirm you are of legal age' }),
  referralCode: z.string().trim().max(20).optional(),
});

const refreshCookie = 'bettingify_refresh';
const refreshCookieOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: config.isProd ? 'none' as const : 'strict' as const,
  path: '/api/v1/auth',
};

function readRefreshCookie(req: import('express').Request) {
  const entry = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${refreshCookie}=`));
  return entry?.slice(refreshCookie.length + 1);
}

function clearRefreshCookie(res: import('express').Response) {
  res.clearCookie(refreshCookie, refreshCookieOptions);
}

function ensureTrustedOrigin(req: import('express').Request) {
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin)) throw forbidden('Request origin is not allowed');
}

function session(u: UserRow, res: import('express').Response, refreshToken?: string) {
  res.cookie(refreshCookie, refreshToken ?? issueRefreshToken(u.id), {
    ...refreshCookieOptions,
    maxAge: config.refreshTtlDays * 86_400_000,
  });
  return { user: userDto(u), accessToken: signAccess({ id: u.id, role: u.role }), expiresInSec: config.accessTtlSec };
}

authRouter.post('/register', ah(async (req, res) => {
  const b = registerSchema.parse(req.body);
  if (!isOldEnough(b.dateOfBirth)) throw new AppError(400, 'MINIMUM_AGE_NOT_MET', `You must be at least ${config.minGamblingAge} to register`);
  if (get('SELECT 1 FROM users WHERE email = ? OR phone = ?', b.email, b.phone)) throw conflict('ACCOUNT_EXISTS', 'An account with this email or phone already exists');
  const passwordHash = await hashPassword(b.password);
  const referrer = b.referralCode ? get<{ id: string }>('SELECT id FROM users WHERE referral_code = ?', b.referralCode.toUpperCase()) : undefined;
  const id = newId('usr');
  const user = tx(() => {
    run(`INSERT INTO users (id,email,phone,password_hash,first_name,last_name,date_of_birth,referral_code,referred_by,terms_accepted_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, b.email, b.phone, passwordHash, b.firstName, b.lastName, b.dateOfBirth, randomBytes(4).toString('hex').toUpperCase(), referrer?.id ?? null, nowIso(), nowIso());
    ensureWallet(id);
    if (config.registerBonusCents > 0) grantBonus(id, config.registerBonusCents, 'Registration free bet');
    return get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
  });
  res.status(201).json(session(user, res));
}));

const loginSchema = z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(128) });
authRouter.post('/login', ah(async (req, res) => {
  const b = loginSchema.parse(req.body);
  const id = b.identifier.trim();
  const u = get<UserRow & { password_hash: string }>('SELECT * FROM users WHERE email = ? OR phone = ?', id.toLowerCase(), id.replace(/[\s\-()]/g, ''));
  const ok = await checkPassword(b.password, u?.password_hash ?? await dummyPasswordHash);
  if (!u || !ok || u.status !== 'active') throw unauthorized('Invalid credentials');
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), u.id);
  res.json(session(u, res));
}));

authRouter.post('/refresh', ah(async (req, res) => {
  ensureTrustedOrigin(req);
  const { refreshToken: legacyToken } = z.object({ refreshToken: z.string().min(10).optional() }).parse(req.body ?? {});
  const token = readRefreshCookie(req) ?? legacyToken;
  if (!token) throw unauthorized('Invalid refresh token');
  let userId: string;
  let refreshToken: string;
  try {
    ({ userId, refreshToken } = rotateRefreshToken(token));
  } catch (error) {
    clearRefreshCookie(res);
    throw error;
  }
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!;
  if (u.status !== 'active') {
    revokeRefreshToken(refreshToken);
    clearRefreshCookie(res);
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Account suspended');
  }
  res.json(session(u, res, refreshToken));
}));

authRouter.post('/logout', requireAuth, ah(async (req, res) => {
  ensureTrustedOrigin(req);
  const { refreshToken: legacyToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
  const token = readRefreshCookie(req) ?? legacyToken;
  if (token) revokeRefreshToken(token);
  clearRefreshCookie(res);
  res.status(204).end();
}));

authRouter.post('/email/resend', requireAuth, (req, res) => {
  const u = get<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users WHERE id = ?', req.user!.id)!;
  if (u.email_verified_at) return res.json({ message: 'Email is already verified' });
  if (config.isProd) throw new AppError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Email delivery is not configured');
  res.json({ message: 'Development verification token created', developmentToken: issueAccountToken(req.user!.id, 'email_verify') });
});

authRouter.post('/email/verify', (req, res) => {
  const { token } = z.object({ token: z.string().length(64) }).parse(req.body);
  const userId = consumeAccountToken(token, 'email_verify');
  run('UPDATE users SET email_verified_at = ? WHERE id = ?', nowIso(), userId);
  res.json({ verified: true });
});

authRouter.post('/password/forgot', (req, res) => {
  const { email } = z.object({ email: z.string().email().max(254).transform((s) => s.toLowerCase()) }).parse(req.body);
  if (config.isProd) throw new AppError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Email delivery is not configured');
  const u = get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
  const developmentToken = u ? issueAccountToken(u.id, 'password_reset') : randomBytes(32).toString('hex');
  res.json({ message: 'If that account exists, password reset instructions have been sent', developmentToken });
});

authRouter.post('/password/reset', ah(async (req, res) => {
  const b = z.object({ token: z.string().length(64), newPassword: z.string().min(8).max(128) }).parse(req.body);
  const userId = consumeAccountToken(b.token, 'password_reset');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(b.newPassword), userId);
  run("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowIso(), userId);
  clearRefreshCookie(res);
  res.status(204).end();
}));
