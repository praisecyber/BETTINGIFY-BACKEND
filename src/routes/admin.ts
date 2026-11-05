import { Router } from 'express';
import { z } from 'zod';
import { all, get, newId, nowIso, run } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { requireAdmin, requireAuth } from '../lib/auth.js';
import { fromCents, toMilli } from '../lib/money.js';
import { cancelMatch, matchDto, settleMatch, type MatchRow } from '../services/bets.js';
import { approveWithdrawal, completeDeposit, failDeposit, getPayment, rejectWithdrawal } from '../services/payments.js';
import { isOldEnough } from '../services/account.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const pay = (p: any) => p && ({ id: p.id, userId: p.user_id, kind: p.kind, method: p.method, amount: fromCents(p.amount), bonus: fromCents(p.bonus_amount), status: p.status, destination: p.destination, note: p.note, createdAt: p.created_at });

adminRouter.get('/payments', (req, res) => {
  const q = z.object({ kind: z.enum(['deposit', 'withdraw']).optional(), status: z.string().optional() }).parse(req.query);
  const where: string[] = ['1=1']; const p: string[] = [];
  if (q.kind) { where.push('kind = ?'); p.push(q.kind); }
  if (q.status) { where.push('status = ?'); p.push(q.status); }
  res.json({ payments: all(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, ...p).map(pay) });
});
adminRouter.post('/withdrawals/:id/approve', ah(async (req, res) => res.json({ payment: pay(await approveWithdrawal(String(req.params.id))) })));
adminRouter.post('/withdrawals/:id/reject', (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
  res.json({ payment: pay(rejectWithdrawal(String(req.params.id), reason)) });
});
adminRouter.post('/deposits/:id/confirm', (req, res) => { completeDeposit(String(req.params.id)); res.json({ payment: pay(getPayment(String(req.params.id))) }); });
adminRouter.post('/deposits/:id/fail', (req, res) => { failDeposit(String(req.params.id)); res.json({ payment: pay(getPayment(String(req.params.id))) }); });

const odds = z.number().min(1.01).max(1000);
adminRouter.post('/matches', (req, res) => {
  const b = z.object({ sport: z.string().min(1), league: z.string().min(1), home: z.string().min(1), away: z.string().min(1), startsAt: z.string().datetime(),
    odds: z.object({ home: odds, draw: odds.or(z.literal(0)).default(0), away: odds }) }).parse(req.body);
  const id = newId('m');
  run('INSERT INTO matches (id,sport,league,home,away,starts_at,odds_home,odds_draw,odds_away) VALUES (?,?,?,?,?,?,?,?,?)', id, b.sport, b.league, b.home, b.away, b.startsAt, toMilli(b.odds.home), toMilli(b.odds.draw), toMilli(b.odds.away));
  res.status(201).json(matchDto(get<MatchRow>('SELECT * FROM matches WHERE id = ?', id)!));
});
adminRouter.patch('/matches/:id', (req, res) => {
  const b = z.object({ status: z.enum(['scheduled', 'live']).optional(), score: z.string().max(30).optional(),
    odds: z.object({ home: odds.optional(), draw: odds.or(z.literal(0)).optional(), away: odds.optional() }).optional() }).parse(req.body);
  const id = String(req.params.id);
  const m = get<MatchRow>('SELECT * FROM matches WHERE id = ?', id);
  if (!m) throw notFound('Match not found');
  run("UPDATE matches SET status = COALESCE(?, status), score = COALESCE(?, score), odds_home = COALESCE(?, odds_home), odds_draw = COALESCE(?, odds_draw), odds_away = COALESCE(?, odds_away) WHERE id = ? AND status IN ('scheduled','live')",
    b.status ?? null, b.score ?? null, b.odds?.home ? toMilli(b.odds.home) : null, b.odds?.draw !== undefined ? toMilli(b.odds.draw) : null, b.odds?.away ? toMilli(b.odds.away) : null, id);
  res.json(matchDto(get<MatchRow>('SELECT * FROM matches WHERE id = ?', id)!));
});
adminRouter.post('/matches/:id/settle', (req, res) => {
  const b = z.object({ result: z.enum(['home', 'draw', 'away']), score: z.string().max(30).optional() }).parse(req.body);
  res.json(settleMatch(String(req.params.id), b.result, b.score));
});
adminRouter.post('/matches/:id/cancel', (req, res) => res.json(cancelMatch(String(req.params.id))));

adminRouter.get('/users', (req, res) => {
  const q = z.object({ q: z.string().max(60).optional() }).parse(req.query);
  const l = `%${(q.q ?? '').toLowerCase()}%`;
  res.json({ users: all<any>(`SELECT u.id,u.email,u.phone,u.first_name,u.last_name,u.status,u.created_at,u.date_of_birth,
    u.email_verified_at,u.age_verification_status,u.identity_verification_status,u.daily_deposit_limit,u.monthly_deposit_limit,
    u.self_excluded_until,u.self_excluded_permanent,w.cash,w.bonus
    FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.role='user' AND (LOWER(u.email) LIKE ? OR u.phone LIKE ?)
    ORDER BY u.created_at DESC LIMIT 100`, l, l)
    .map((u) => ({
      id: u.id, email: u.email, phone: u.phone, name: `${u.first_name} ${u.last_name}`, status: u.status,
      createdAt: u.created_at, dateOfBirth: u.date_of_birth, emailVerified: !!u.email_verified_at,
      ageVerificationStatus: u.age_verification_status, identityVerificationStatus: u.identity_verification_status,
      dailyDepositLimit: u.daily_deposit_limit === null ? null : fromCents(u.daily_deposit_limit),
      monthlyDepositLimit: u.monthly_deposit_limit === null ? null : fromCents(u.monthly_deposit_limit),
      selfExcludedUntil: u.self_excluded_permanent ? 'permanent' : u.self_excluded_until,
      cash: fromCents(u.cash), bonus: fromCents(u.bonus),
    })) });
});
adminRouter.patch('/users/:id/status', (req, res) => {
  const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
  const id = String(req.params.id);
  if (run("UPDATE users SET status = ? WHERE id = ? AND role = 'user'", status, id).changes === 0) throw notFound('User not found');
  if (status === 'suspended') run("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", id);
  res.json({ id, status });
});

adminRouter.patch('/users/:id/verification', (req, res) => {
  const b = z.object({
    age: z.enum(['pending', 'verified', 'rejected']).optional(),
    identity: z.enum(['pending', 'verified', 'rejected']).optional(),
    note: z.string().trim().min(1).max(300),
  }).refine((v) => v.age !== undefined || v.identity !== undefined, 'At least one verification status is required').parse(req.body);
  const id = String(req.params.id);
  const user = get<{ date_of_birth: string | null }>("SELECT date_of_birth FROM users WHERE id = ? AND role = 'user'", id);
  if (!user) throw notFound('User not found');
  if (b.age === 'verified' && (!user.date_of_birth || !isOldEnough(user.date_of_birth)))
    throw badRequest('MINIMUM_AGE_NOT_MET', 'The user does not meet the configured minimum gambling age');
  const updates: string[] = [];
  const values: string[] = [];
  if (b.age !== undefined) { updates.push('age_verification_status = ?'); values.push(b.age); }
  if (b.identity !== undefined) { updates.push('identity_verification_status = ?'); values.push(b.identity); }
  run(`UPDATE users SET ${updates.join(',')} WHERE id = ?`, ...values, id);
  const reviewed = get<{ age_verification_status: string; identity_verification_status: string }>(
    'SELECT age_verification_status,identity_verification_status FROM users WHERE id = ?', id,
  )!;
  run(`INSERT INTO account_verification_events (id,user_id,actor_id,age_status,identity_status,note,created_at)
    VALUES (?,?,?,?,?,?,?)`, newId('ve'), id, req.user!.id, reviewed.age_verification_status,
  reviewed.identity_verification_status, b.note, nowIso());
  res.json({ id, age: b.age, identity: b.identity });
});

adminRouter.get('/users/:id/verification-events', (req, res) => {
  const id = String(req.params.id);
  if (!get("SELECT 1 FROM users WHERE id = ? AND role = 'user'", id)) throw notFound('User not found');
  res.json({ events: all('SELECT actor_id AS actorId,age_status AS age,identity_status AS identity,note,created_at AS createdAt FROM account_verification_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', id) });
});

adminRouter.get('/stats', (_req, res) => {
  const s = get<any>(`SELECT
    (SELECT COUNT(*) FROM users WHERE role='user') users,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE kind='deposit' AND status='completed') deposits,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE kind='withdraw' AND status='completed') withdrawals,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE kind='withdraw' AND status IN ('pending','processing')) pending_withdrawals,
    (SELECT COALESCE(SUM(stake),0) FROM bets) turnover,
    (SELECT COALESCE(SUM(stake - payout),0) FROM bets WHERE status IN ('won','lost','cashed_out')) ggr,
    (SELECT COALESCE(SUM(cash+bonus),0) FROM wallets) player_liabilities`)!;
  res.json({ users: s.users, deposits: fromCents(s.deposits), withdrawals: fromCents(s.withdrawals), pendingWithdrawals: fromCents(s.pending_withdrawals), turnover: fromCents(s.turnover), grossGamingRevenue: fromCents(s.ggr), playerLiabilities: fromCents(s.player_liabilities) });
});
