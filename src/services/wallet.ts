import { config } from '../config.js';
import { all, get, newId, nowIso, run, tx } from '../db.js';
import { AppError } from '../lib/errors.js';

export interface Wallet { cash: number; bonus: number; wagerRemaining: number }
export type Bucket = 'cash' | 'bonus';

export function ensureWallet(userId: string) {
  run('INSERT OR IGNORE INTO wallets (user_id, cash, bonus, wager_remaining, updated_at) VALUES (?,0,0,0,?)', userId, nowIso());
}

export function getWallet(userId: string): Wallet {
  const w = get<{ cash: number; bonus: number; wager_remaining: number }>('SELECT * FROM wallets WHERE user_id = ?', userId);
  if (!w) throw new AppError(500, 'NO_WALLET', 'Wallet missing');
  return { cash: w.cash, bonus: w.bonus, wagerRemaining: w.wager_remaining };
}

interface PostOpts { type: string; refType?: string; refId?: string; description?: string }

/** The ONLY place balances change. Updates the wallet and appends a ledger row. Call inside tx(). */
function post(userId: string, bucket: Bucket, delta: number, o: PostOpts) {
  if (delta === 0) return;
  const w = getWallet(userId);
  const next = w[bucket] + delta;
  if (next < 0) throw new AppError(400, 'INSUFFICIENT_FUNDS', 'Insufficient balance');
  run(`UPDATE wallets SET ${bucket} = ?, updated_at = ? WHERE user_id = ?`, next, nowIso(), userId);
  run(`INSERT INTO ledger (id, user_id, type, bucket, amount, balance_after, ref_type, ref_id, description, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId('led'), userId, o.type, bucket, delta, next, o.refType ?? null, o.refId ?? null, o.description ?? null, nowIso());
}

export const creditCash = (userId: string, amount: number, o: PostOpts) => tx(() => post(userId, 'cash', amount, o));
export const debitCash = (userId: string, amount: number, o: PostOpts) => tx(() => post(userId, 'cash', -amount, o));

/** Promo funds: locked until `amount * BONUS_WAGER_MULT` has been staked. */
export function grantBonus(userId: string, amount: number, description: string, refType?: string, refId?: string) {
  if (amount <= 0) return;
  tx(() => {
    post(userId, 'bonus', amount, { type: 'bonus_grant', description, refType, refId });
    run('UPDATE wallets SET wager_remaining = wager_remaining + ? WHERE user_id = ?', amount * config.bonusWagerMultiplier, userId);
  });
}

/** Stake is taken from cash first, then bonus. Also counts toward the wagering requirement. */
export function debitStake(userId: string, stake: number, ref: { refType: string; refId: string; description: string }) {
  return tx(() => {
    const w = getWallet(userId);
    if (w.cash + w.bonus < stake) throw new AppError(400, 'INSUFFICIENT_FUNDS', 'Insufficient balance');
    const fromCash = Math.min(w.cash, stake);
    const fromBonus = stake - fromCash;
    post(userId, 'cash', -fromCash, { type: 'bet', ...ref });
    post(userId, 'bonus', -fromBonus, { type: 'bet', ...ref });
    applyWagering(userId, stake);
    return { fromCash, fromBonus };
  });
}

function applyWagering(userId: string, stake: number) {
  const w = getWallet(userId);
  if (w.bonus === 0) {
    if (w.wagerRemaining > 0) run('UPDATE wallets SET wager_remaining = 0 WHERE user_id = ?', userId);
    return;
  }
  const remaining = Math.max(0, w.wagerRemaining - stake);
  run('UPDATE wallets SET wager_remaining = ? WHERE user_id = ?', remaining, userId);
  if (remaining === 0 && w.bonus > 0) {
    // wagering met: unlock the bonus into withdrawable cash
    post(userId, 'bonus', -w.bonus, { type: 'bonus_release', description: 'Wagering requirement met' });
    post(userId, 'cash', w.bonus, { type: 'bonus_release', description: 'Wagering requirement met' });
  }
}

/** Pays winnings/refunds back into the same buckets the stake came from (pro rata). */
export function creditReturn(
  userId: string, amount: number, stake: { total: number; cash: number; bonus: number },
  o: PostOpts,
) {
  if (amount <= 0) return;
  tx(() => {
    const bonusShare = stake.total > 0 ? Math.floor((amount * stake.bonus) / stake.total) : 0;
    post(userId, 'cash', amount - bonusShare, o);
    post(userId, 'bonus', bonusShare, o);
  });
}

export function listLedger(userId: string, limit: number) {
  return all('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit);
}
