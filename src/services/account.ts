import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { get, newId, nowIso, run, tx } from '../db.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export function isOldEnough(dateOfBirth: string, today = new Date()) {
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (!Number.isFinite(dob.getTime()) || dob.toISOString().slice(0, 10) !== dateOfBirth
    || dob.getUTCFullYear() < 1900 || dob.getTime() > today.getTime()) return false;
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const month = today.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && today.getUTCDate() < dob.getUTCDate())) age--;
  return age >= config.minGamblingAge;
}

export function requireVerificationReady(userId: string) {
  const user = get<{
    role: string;
    email_verified_at: string | null;
    age_verification_status: VerificationStatus;
    identity_verification_status: VerificationStatus;
    self_excluded_until: string | null;
    self_excluded_permanent: number;
  }>('SELECT role,email_verified_at,age_verification_status,identity_verification_status,self_excluded_until,self_excluded_permanent FROM users WHERE id = ?', userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found');
  if (user.role === 'admin') return;
  if (!user.email_verified_at) throw conflict('EMAIL_NOT_VERIFIED', 'Verify your email before betting or depositing');
  if (user.age_verification_status !== 'verified' || user.identity_verification_status !== 'verified')
    throw conflict('VERIFICATION_REQUIRED', 'Age and identity verification must be approved before betting or depositing');
}

export function requireGamblingEligible(userId: string) {
  requireVerificationReady(userId);
  if (isSelfExcluded(userId)) throw conflict('SELF_EXCLUDED', 'This account is currently self-excluded');
}

export function isSelfExcluded(userId: string) {
  const row = get<{ permanent: number; until: string | null }>(
    'SELECT self_excluded_permanent AS permanent,self_excluded_until AS until FROM users WHERE id = ?', userId,
  );
  return !!row && (!!row.permanent || (!!row.until && Date.parse(row.until) > Date.now()));
}

export function setDepositLimits(userId: string, daily: number | null | undefined, monthly: number | null | undefined) {
  const current = get<{ daily_deposit_limit: number | null; monthly_deposit_limit: number | null }>(
    'SELECT daily_deposit_limit,monthly_deposit_limit FROM users WHERE id = ?', userId,
  );
  if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found');
  const nextDaily = daily === undefined ? current.daily_deposit_limit : daily;
  const nextMonthly = monthly === undefined ? current.monthly_deposit_limit : monthly;
  if (nextDaily !== null && nextMonthly !== null && nextDaily > nextMonthly)
    throw badRequest('INVALID_LIMITS', 'The daily deposit limit cannot exceed the monthly limit');
  run('UPDATE users SET daily_deposit_limit = ?,monthly_deposit_limit = ? WHERE id = ?', nextDaily, nextMonthly, userId);
  return { daily: nextDaily, monthly: nextMonthly };
}

export function checkDepositLimit(userId: string, amount: number) {
  const u = get<{ daily: number | null; monthly: number | null }>(
    'SELECT daily_deposit_limit AS daily,monthly_deposit_limit AS monthly FROM users WHERE id = ?', userId,
  );
  if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found');
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const totals = get<{ daily: number; monthly: number }>(`SELECT
    COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END),0) AS daily,
    COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END),0) AS monthly
    FROM payments WHERE user_id = ? AND kind = 'deposit' AND status IN ('pending','processing','completed')`,
  dayStart, monthStart, userId)!;
  if (u.daily !== null && totals.daily + amount > u.daily)
    throw badRequest('DEPOSIT_LIMIT_REACHED', 'This deposit would exceed your daily deposit limit', { limit: u.daily / 100, remaining: Math.max(0, u.daily - totals.daily) / 100 });
  if (u.monthly !== null && totals.monthly + amount > u.monthly)
    throw badRequest('DEPOSIT_LIMIT_REACHED', 'This deposit would exceed your monthly deposit limit', { limit: u.monthly / 100, remaining: Math.max(0, u.monthly - totals.monthly) / 100 });
}

export function startSelfExclusion(userId: string, duration: '24h' | '7d' | '30d' | '6m' | 'permanent') {
  const current = get<{ until: string | null; permanent: number }>(
    'SELECT self_excluded_until AS until,self_excluded_permanent AS permanent FROM users WHERE id = ?', userId,
  );
  if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found');
  if (current.permanent) return { until: null, permanent: true };
  if (duration === 'permanent') {
    run('UPDATE users SET self_excluded_until = NULL,self_excluded_permanent = 1 WHERE id = ?', userId);
    return { until: null, permanent: true };
  }
  const now = Date.now();
  const untilDate = new Date(now);
  if (duration === '24h') untilDate.setTime(now + 86_400_000);
  else if (duration === '7d') untilDate.setTime(now + 7 * 86_400_000);
  else if (duration === '30d') untilDate.setTime(now + 30 * 86_400_000);
  else {
    const day = untilDate.getUTCDate();
    untilDate.setUTCDate(1);
    untilDate.setUTCMonth(untilDate.getUTCMonth() + 6);
    const lastDay = new Date(Date.UTC(untilDate.getUTCFullYear(), untilDate.getUTCMonth() + 1, 0)).getUTCDate();
    untilDate.setUTCDate(Math.min(day, lastDay));
  }
  const until = new Date(Math.max(Date.parse(current.until ?? '') || 0, untilDate.getTime())).toISOString();
  run('UPDATE users SET self_excluded_until = ? WHERE id = ?', until, userId);
  return { until, permanent: false };
}

export function issueAccountToken(userId: string, purpose: 'email_verify' | 'password_reset') {
  const token = randomBytes(32).toString('hex');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + (purpose === 'email_verify' ? 24 : 1) * 60 * 60 * 1000).toISOString();
  tx(() => {
    run('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', now, userId, purpose);
    run('INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      newId('tok'), userId, purpose, createHash('sha256').update(token).digest('hex'), expiresAt, now);
  });
  return token;
}

export function consumeAccountToken(token: string, purpose: 'email_verify' | 'password_reset') {
  const hash = createHash('sha256').update(token).digest('hex');
  return tx(() => {
    const row = get<{ id: string; user_id: string }>(
      'SELECT id,user_id FROM account_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
      hash, purpose, nowIso(),
    );
    if (!row) throw badRequest('INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired');
    run('UPDATE account_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', nowIso(), row.id);
    return row.user_id;
  });
}
