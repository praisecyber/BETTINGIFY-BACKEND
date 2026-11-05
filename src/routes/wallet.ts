import { Router } from 'express';
import { z } from 'zod';
import { all } from '../db.js';
import { ah } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { fromCents, moneyIn } from '../lib/money.js';
import { cancelWithdrawal, createDeposit, listMethods, requestWithdrawal, welcomeBonusEligible, type Payment } from '../services/payments.js';
import { walletDto } from './me.js';

export const walletRouter = Router();
walletRouter.use(requireAuth);

const paymentDto = (p: Payment) => ({ id: p.id, kind: p.kind, method: p.method, amount: fromCents(p.amount), bonus: fromCents(p.bonus_amount), status: p.status, note: p.note, createdAt: p.created_at });

walletRouter.get('/', (req, res) => res.json({ ...walletDto(req.user!.id), welcomeBonusAvailable: welcomeBonusEligible(req.user!.id) }));

walletRouter.get('/methods', (req, res) => {
  const kind = z.enum(['deposit', 'withdraw']).optional().parse(req.query.kind);
  res.json({ methods: listMethods(kind).map((m) => ({ id: m.id, name: m.name, min: fromCents(m.min_amount), max: fromCents(m.max_amount), time: m.eta, icon: m.icon })) });
});

walletRouter.post('/deposit', idempotent, ah(async (req, res) => {
  const b = z.object({ method: z.string(), amount: moneyIn, claimWelcomeBonus: z.boolean().default(false) }).parse(req.body);
  const { payment, redirectUrl } = await createDeposit(req.user!.id, b.method, b.amount, b.claimWelcomeBonus);
  res.status(payment.status === 'completed' ? 201 : 202).json({ payment: paymentDto(payment), redirectUrl, wallet: walletDto(req.user!.id) });
}));

walletRouter.post('/withdraw', idempotent, (req, res) => {
  const b = z.object({ method: z.string(), amount: moneyIn, destination: z.string().max(200).optional() }).parse(req.body);
  const p = requestWithdrawal(req.user!.id, b.method, b.amount, b.destination ?? null);
  res.status(202).json({ payment: paymentDto(p), wallet: walletDto(req.user!.id) });
});

walletRouter.post('/withdrawals/:id/cancel', (req, res) => {
  const p = cancelWithdrawal(req.user!.id, String(req.params.id));
  res.json({ payment: paymentDto(p), wallet: walletDto(req.user!.id) });
});

/** Unified history: deposits/withdrawals (with status) + bets, wins, cash-outs, refunds. */
walletRouter.get('/transactions', (req, res) => {
  const q = z.object({ type: z.enum(['deposit', 'withdraw', 'bet', 'win']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().optional() }).parse(req.query);
  const uid = req.user!.id;
  const before = q.before ?? '9999';
  const pays = all<Payment>('SELECT * FROM payments WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', uid, before, q.limit)
    .map((p) => ({ id: p.id, type: p.kind, amount: fromCents(p.amount), status: p.status === 'processing' ? 'pending' : p.status === 'completed' ? 'completed' : p.status === 'pending' ? 'pending' : 'failed', method: p.method, date: p.created_at }));
  const led = all<{ id: string; type: string; amount: number; description: string; created_at: string }>(
    "SELECT * FROM ledger WHERE user_id = ? AND bucket IN ('cash','bonus') AND type IN ('bet','win','cashout','bet_refund','jackpot_entry','jackpot_win') AND created_at < ? ORDER BY created_at DESC LIMIT ?", uid, before, q.limit * 2);
  // a stake split across cash+bonus produces two ledger rows; merge per bet
  const merged = new Map<string, { id: string; type: string; amount: number; status: string; method: string; date: string }>();
  for (const l of led) {
    const type = l.type === 'bet' || l.type === 'jackpot_entry' ? 'bet' : l.type === 'bet_refund' ? 'refund' : 'win';
    const key = `${type}:${l.description}:${l.created_at}`;
    const prev = merged.get(key);
    if (prev) prev.amount += fromCents(Math.abs(l.amount));
    else merged.set(key, { id: l.id, type, amount: fromCents(Math.abs(l.amount)), status: 'completed', method: l.description, date: l.created_at });
  }
  let items = [...pays, ...merged.values()];
  if (q.type) items = items.filter((i) => i.type === q.type);
  items.sort((a, b) => b.date.localeCompare(a.date));
  items = items.slice(0, q.limit);
  res.json({ transactions: items, nextBefore: items.length === q.limit ? items[items.length - 1].date : null });
});
