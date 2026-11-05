import { Router } from 'express';
import { z } from 'zod';
import { all, get, newId, nowIso, run } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { checkPassword, hashPassword, requireAuth } from '../lib/auth.js';
import { getWallet } from '../services/wallet.js';
import { matchDto, type MatchRow } from '../services/bets.js';
import { fromCents, moneyIn } from '../lib/money.js';
import { isOldEnough, setDepositLimits, startSelfExclusion } from '../services/account.js';

export interface UserRow {
  id: string; email: string; phone: string; password_hash?: string; first_name: string; last_name: string;
  role: 'user' | 'admin'; status: string; referral_code: string; created_at: string;
  date_of_birth: string | null; email_verified_at: string | null; age_verification_status: string;
  identity_verification_status: string; daily_deposit_limit: number | null; monthly_deposit_limit: number | null;
  self_excluded_until: string | null; self_excluded_permanent: number;
}
export const userDto = (u: UserRow) => {
  const excluded = !!u.self_excluded_permanent || (!!u.self_excluded_until && Date.parse(u.self_excluded_until) > Date.now());
  return ({
  id: u.id, email: u.email, phone: u.phone, firstName: u.first_name, lastName: u.last_name,
  role: u.role, referralCode: u.referral_code, createdAt: u.created_at,
  dateOfBirth: u.date_of_birth, emailVerified: !!u.email_verified_at,
  ageVerificationStatus: u.age_verification_status, identityVerificationStatus: u.identity_verification_status,
  depositLimits: { daily: u.daily_deposit_limit === null ? null : fromCents(u.daily_deposit_limit), monthly: u.monthly_deposit_limit === null ? null : fromCents(u.monthly_deposit_limit) },
  selfExcludedUntil: excluded ? (u.self_excluded_permanent ? 'permanent' : u.self_excluded_until) : null,
  });
};

export const meRouter = Router();
meRouter.use(requireAuth);

export const walletDto = (userId: string) => {
  const w = getWallet(userId);
  return { balance: fromCents(w.cash + w.bonus), withdrawable: fromCents(w.cash), bonus: fromCents(w.bonus), bonusWagerRemaining: fromCents(w.wagerRemaining), currency: 'NGN' };
};

meRouter.get('/', (req, res) => {
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id);
  if (!u) throw notFound();
  res.json({ ...userDto(u), wallet: walletDto(u.id) });
});

meRouter.patch('/', (req, res) => {
  const b = z.object({ firstName: z.string().trim().min(1).max(60).optional(), lastName: z.string().trim().min(1).max(60).optional() }).parse(req.body);
  run('UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name) WHERE id = ?', b.firstName ?? null, b.lastName ?? null, req.user!.id);
  res.json(userDto(get<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!));
});

meRouter.post('/verification', (req, res) => {
  const { dateOfBirth } = z.object({ dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id);
  if (!u) throw notFound();
  if (dateOfBirth && !isOldEnough(dateOfBirth)) throw badRequest('MINIMUM_AGE_NOT_MET', 'You do not meet the configured minimum gambling age');
  if (u.date_of_birth && dateOfBirth && u.date_of_birth !== dateOfBirth)
    throw badRequest('DATE_OF_BIRTH_IMMUTABLE', 'Contact support to correct your date of birth');
  const dob = u.date_of_birth ?? dateOfBirth;
  if (!dob) throw badRequest('DATE_OF_BIRTH_REQUIRED', 'Date of birth is required');
  if (u.age_verification_status !== 'verified' || u.identity_verification_status !== 'verified') {
    run(`UPDATE users SET date_of_birth = ?,
      age_verification_status = CASE WHEN age_verification_status = 'verified' THEN 'verified' ELSE 'pending' END,
      identity_verification_status = CASE WHEN identity_verification_status = 'verified' THEN 'verified' ELSE 'pending' END
      WHERE id = ?`, dob, req.user!.id);
    const updated = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
    run(`INSERT INTO account_verification_events (id,user_id,actor_id,age_status,identity_status,note,created_at)
      VALUES (?,?,?,?,?,?,?)`, newId('ve'), req.user!.id, req.user!.id,
    updated.age_verification_status, updated.identity_verification_status, 'User requested review', nowIso());
  }
  res.json(userDto(get<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!));
});

meRouter.patch('/deposit-limits', (req, res) => {
  const limit = moneyIn.nullable().optional();
  const b = z.object({ daily: limit, monthly: limit }).refine((v) => v.daily !== undefined || v.monthly !== undefined, 'At least one limit must be provided').parse(req.body);
  const limits = setDepositLimits(req.user!.id, b.daily, b.monthly);
  res.json({ daily: limits.daily === null ? null : fromCents(limits.daily), monthly: limits.monthly === null ? null : fromCents(limits.monthly) });
});

meRouter.post('/self-exclude', (req, res) => {
  const { duration } = z.object({ duration: z.enum(['24h', '7d', '30d', '6m', 'permanent']) }).parse(req.body);
  res.json(startSelfExclusion(req.user!.id, duration));
});

meRouter.post('/password', ah(async (req, res) => {
  const b = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }).parse(req.body);
  const u = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
  if (!(await checkPassword(b.currentPassword, u.password_hash))) throw badRequest('WRONG_PASSWORD', 'Current password is incorrect');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(b.newPassword), req.user!.id);
  run('UPDATE refresh_tokens SET revoked_at = datetime(\'now\') WHERE user_id = ? AND revoked_at IS NULL', req.user!.id); // sign out other sessions
  res.status(204).end();
}));

/** matches the user has bets on (the frontend "My Matches" page) */
meRouter.get('/matches', (req, res) => {
  const rows = all<MatchRow>(`SELECT DISTINCT m.* FROM matches m
    WHERE EXISTS (SELECT 1 FROM bets b WHERE b.user_id=? AND b.match_id=m.id)
       OR EXISTS (SELECT 1 FROM bet_legs l JOIN bets b ON b.id=l.bet_id WHERE b.user_id=? AND l.match_id=m.id)
    ORDER BY m.starts_at DESC LIMIT 50`, req.user!.id, req.user!.id);
  res.json({ matches: rows.map(matchDto) });
});
