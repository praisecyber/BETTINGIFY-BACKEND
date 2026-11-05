import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { all, get, newId, nowIso, run, tx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { creditCash, debitCash, getWallet, grantBonus } from './wallet.js';
import { checkDepositLimit, requireGamblingEligible, requireVerificationReady } from './account.js';

/**
 * Payment provider boundary. The mock below simulates a gateway so the whole flow works locally.
 * For production implement this interface with a real gateway (Paystack, Flutterwave, Stripe, a crypto
 * processor...). Card numbers must NEVER touch this server — use the gateway's hosted checkout/tokens.
 */
export interface PaymentProvider {
  name: string;
  charge(i: { paymentId: string; userId: string; method: string; amountCents: number }): Promise<{ providerRef: string; status: 'completed' | 'pending'; redirectUrl?: string }>;
  payout(i: { paymentId: string; userId: string; method: string; amountCents: number; destination: string | null }): Promise<{ providerRef: string }>;
}

const INSTANT = new Set(['visa', 'mastercard', 'paypal']);
export const mockProvider: PaymentProvider = {
  name: 'mock',
  async charge({ method }) {
    return { providerRef: `mock_${randomBytes(8).toString('hex')}`, status: INSTANT.has(method) ? 'completed' : 'pending' };
  },
  async payout() {
    return { providerRef: `mockpo_${randomBytes(8).toString('hex')}` };
  },
};
let provider: PaymentProvider = mockProvider;
export const setPaymentProvider = (p: PaymentProvider) => { provider = p; };

interface Method { id: string; name: string; min_amount: number; max_amount: number; eta: string; icon: string; can_deposit: number; can_withdraw: number; enabled: number }
export interface Payment { id: string; user_id: string; kind: 'deposit' | 'withdraw'; method: string; amount: number; bonus_amount: number; status: string; provider_ref: string | null; destination: string | null; note: string | null; created_at: string; updated_at: string }

export const listMethods = (kind?: 'deposit' | 'withdraw') =>
  all<Method>(`SELECT * FROM payment_methods WHERE enabled = 1 ${kind ? `AND can_${kind} = 1` : ''} ORDER BY rowid`);

function method(id: string, kind: 'deposit' | 'withdraw') {
  const m = get<Method>('SELECT * FROM payment_methods WHERE id = ? AND enabled = 1', id);
  if (!m || !m[kind === 'deposit' ? 'can_deposit' : 'can_withdraw']) throw badRequest('BAD_METHOD', `Method not available for ${kind}`);
  return m;
}
function checkLimits(m: Method, amount: number) {
  if (amount < m.min_amount || amount > m.max_amount)
    throw badRequest('AMOUNT_OUT_OF_RANGE', `${m.name}: amount must be between ${m.min_amount / 100} and ${m.max_amount / 100}`);
}

export function welcomeBonusEligible(userId: string) {
  const u = get<{ welcome_bonus_claimed: number }>('SELECT welcome_bonus_claimed FROM users WHERE id = ?', userId);
  const prior = get<{ c: number }>("SELECT COUNT(*) c FROM payments WHERE user_id = ? AND kind = 'deposit' AND status = 'completed'", userId)!.c;
  return !!u && !u.welcome_bonus_claimed && prior === 0;
}

export async function createDeposit(userId: string, methodId: string, amount: number, wantBonus: boolean) {
  const m = method(methodId, 'deposit');
  checkLimits(m, amount);
  const bonus = wantBonus && welcomeBonusEligible(userId) ? Math.min(amount, config.welcomeBonusMaxCents) : 0;
  const id = newId('pay');
  tx(() => {
    requireGamblingEligible(userId);
    checkDepositLimit(userId, amount);
    run(`INSERT INTO payments (id, user_id, kind, method, amount, bonus_amount, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, id, userId, 'deposit', methodId, amount, bonus, 'pending', nowIso(), nowIso());
  });
  try {
    const r = await provider.charge({ paymentId: id, userId, method: methodId, amountCents: amount });
    run('UPDATE payments SET provider_ref = ?, updated_at = ? WHERE id = ?', r.providerRef, nowIso(), id);
    if (r.status === 'completed') completeDeposit(id);
    return { payment: getPayment(id)!, redirectUrl: r.redirectUrl };
  } catch (e) {
    run("UPDATE payments SET status = 'failed', note = ?, updated_at = ? WHERE id = ? AND status = 'pending'", 'Provider error', nowIso(), id);
    throw new AppError(502, 'PROVIDER_ERROR', 'Payment provider failed, please try again');
  }
}

/** Idempotent: only the first call on a pending deposit credits money. */
export function completeDeposit(paymentId: string) {
  return tx(() => {
    const p = get<Payment>("SELECT * FROM payments WHERE id = ? AND kind = 'deposit'", paymentId);
    if (!p) throw notFound('Payment not found');
    if (p.status !== 'pending') return p;
    let bonus = p.bonus_amount;
    if (bonus > 0 && !welcomeBonusEligible(p.user_id)) bonus = 0;
    run("UPDATE payments SET status = 'completed', bonus_amount = ?, updated_at = ? WHERE id = ?", bonus, nowIso(), paymentId);
    creditCash(p.user_id, p.amount, { type: 'deposit', refType: 'payment', refId: paymentId, description: `Deposit via ${p.method}` });
    if (bonus > 0) {
      grantBonus(p.user_id, bonus, '100% welcome bonus', 'payment', paymentId);
      run('UPDATE users SET welcome_bonus_claimed = 1 WHERE id = ?', p.user_id);
    }
    return getPayment(paymentId)!;
  });
}

export function failDeposit(paymentId: string, note = 'Declined by provider') {
  run("UPDATE payments SET status = 'failed', note = ?, updated_at = ? WHERE id = ? AND kind = 'deposit' AND status = 'pending'", note, nowIso(), paymentId);
}

export function getPayment(id: string) { return get<Payment>('SELECT * FROM payments WHERE id = ?', id); }

export function requestWithdrawal(userId: string, methodId: string, amount: number, destination: string | null) {
  const m = method(methodId, 'withdraw');
  checkLimits(m, amount);
  return tx(() => {
    requireVerificationReady(userId);
    const w = getWallet(userId);
    if (amount > w.cash)
      throw badRequest('INSUFFICIENT_WITHDRAWABLE', 'Amount exceeds your withdrawable balance (bonus funds are locked)', { withdrawable: w.cash / 100 });
    const id = newId('pay');
    run(`INSERT INTO payments (id, user_id, kind, method, amount, status, destination, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, id, userId, 'withdraw', methodId, amount, 'pending', destination, nowIso(), nowIso());
    debitCash(userId, amount, { type: 'withdraw', refType: 'payment', refId: id, description: `Withdrawal via ${methodId}` });
    return getPayment(id)!;
  });
}

function refundWithdrawal(p: Payment, newStatus: 'rejected' | 'cancelled' | 'failed', note: string) {
  tx(() => {
    const r = run("UPDATE payments SET status = ?, note = ?, updated_at = ? WHERE id = ? AND kind = 'withdraw' AND status IN ('pending','processing')",
      newStatus, note, nowIso(), p.id);
    if (r.changes === 0) throw conflict('NOT_PENDING', 'Withdrawal is no longer pending');
    creditCash(p.user_id, p.amount, { type: 'withdraw_refund', refType: 'payment', refId: p.id, description: `Withdrawal ${newStatus}` });
  });
}

export function cancelWithdrawal(userId: string, paymentId: string) {
  const p = get<Payment>("SELECT * FROM payments WHERE id = ? AND user_id = ? AND kind = 'withdraw'", paymentId, userId);
  if (!p) throw notFound('Withdrawal not found');
  if (p.status !== 'pending') throw conflict('NOT_PENDING', 'Only pending withdrawals can be cancelled');
  refundWithdrawal(p, 'cancelled', 'Cancelled by user');
  return getPayment(paymentId)!;
}

export function rejectWithdrawal(paymentId: string, reason: string) {
  const p = get<Payment>("SELECT * FROM payments WHERE id = ? AND kind = 'withdraw'", paymentId);
  if (!p) throw notFound('Withdrawal not found');
  if (p.status !== 'pending') throw conflict('NOT_PENDING', 'Withdrawal is not pending');
  refundWithdrawal(p, 'rejected', reason);
  return getPayment(paymentId)!;
}

export async function approveWithdrawal(paymentId: string) {
  // claim it atomically so two admins can't pay out twice
  const claimed = run("UPDATE payments SET status = 'processing', updated_at = ? WHERE id = ? AND kind = 'withdraw' AND status = 'pending'", nowIso(), paymentId);
  const p = getPayment(paymentId);
  if (!p || p.kind !== 'withdraw') throw notFound('Withdrawal not found');
  if (claimed.changes === 0) throw conflict('NOT_PENDING', 'Withdrawal is not pending');
  try {
    const r = await provider.payout({ paymentId, userId: p.user_id, method: p.method, amountCents: p.amount, destination: p.destination });
    run("UPDATE payments SET status = 'completed', provider_ref = ?, updated_at = ? WHERE id = ?", r.providerRef, nowIso(), paymentId);
  } catch {
    run("UPDATE payments SET status = 'pending', note = 'Payout failed, retry', updated_at = ? WHERE id = ?", nowIso(), paymentId);
    throw new AppError(502, 'PROVIDER_ERROR', 'Payout failed, withdrawal left pending');
  }
  return getPayment(paymentId)!;
}

/** HMAC-SHA256 over the raw body, hex, sent as `x-signature`. */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined) {
  if (!rawBody || !signature) return false;
  const expected = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handleProviderEvent(providerRef: string, status: 'completed' | 'failed') {
  const p = get<Payment>("SELECT * FROM payments WHERE provider_ref = ? AND kind = 'deposit'", providerRef);
  if (!p) throw notFound('Unknown provider reference');
  if (status === 'completed') completeDeposit(p.id); else failDeposit(p.id);
  return getPayment(p.id)!;
}
