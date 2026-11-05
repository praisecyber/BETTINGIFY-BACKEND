import { all, get, newId, nowIso, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { fromCents } from '../lib/money.js';
import { grantBonus } from './wallet.js';
import { isSelfExcluded } from './account.js';

const DAY = 86_400_000;
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const TIERS = [['Bronze', 0], ['Silver', 100_000], ['Gold', 500_000], ['Platinum', 2_000_000]] as const;

interface Computed { id: string; title: string; desc: string; reward: string; icon: string; progress: number; claimable: boolean; amount: number; key: string }

function compute(userId: string): Computed[] {
  const out: Computed[] = [];
  const claimed = (gift: string, key: string) => !!get('SELECT 1 FROM gift_claims WHERE user_id = ? AND gift_id = ? AND period_key = ?', userId, gift, key);

  // daily
  const dk = dayKey();
  const dailyDone = claimed('daily', dk);
  out.push({ id: 'daily', title: 'Daily Bonus', desc: 'Claim your free daily bonus', reward: '₦5 Free Bet', icon: 'gift', progress: dailyDone ? 0 : 100, claimable: !dailyDone, amount: 500, key: dk });

  // weekly cashback: 10% of net losses over the last 7 days
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const net = get<{ n: number }>("SELECT COALESCE(SUM(stake - payout),0) n FROM bets WHERE user_id = ? AND status IN ('won','lost','cashed_out') AND settled_at >= ?", userId, since)!.n;
  const cb = Math.max(0, Math.floor(net * 0.1));
  const wk = `w${Math.floor(Date.now() / (7 * DAY))}`;
  const cbDone = claimed('cashback', wk);
  out.push({ id: 'cashback', title: 'Weekly Cashback', desc: '10% cashback on weekly losses', reward: `₦${fromCents(cb).toFixed(2)}`, icon: 'rotate', progress: cbDone ? 0 : cb >= 100 ? 100 : Math.round(cb), claimable: !cbDone && cb >= 100, amount: cb, key: wk });

  // deposit streak
  const days = new Set(all<{ d: string }>("SELECT DISTINCT substr(created_at,1,10) d FROM payments WHERE user_id = ? AND kind='deposit' AND status='completed' AND created_at >= ?", userId, new Date(Date.now() - 30 * DAY).toISOString()).map((r) => r.d));
  let end = new Date();
  if (!days.has(dayKey(end))) end = new Date(end.getTime() - DAY);
  let streak = 0;
  for (let d = end; days.has(dayKey(d)); d = new Date(d.getTime() - DAY)) streak++;
  const cycle = Math.floor(streak / 3);
  const skey = `s${dayKey(new Date(end.getTime() - (streak - 1) * DAY))}-${cycle}`;
  out.push({ id: 'streak', title: 'Deposit Streak', desc: 'Deposit 3 days in a row', reward: '₦15 Free Bet', icon: 'flame', progress: Math.min(100, Math.round(((streak % 3 === 0 && streak > 0 ? 3 : streak % 3) / 3) * 100)), claimable: cycle >= 1 && !claimed('streak', skey), amount: 1500, key: skey });

  // referrals: every 2 referred users who deposit => ₦50
  const q = get<{ c: number }>("SELECT COUNT(*) c FROM users u WHERE u.referred_by = ? AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.kind='deposit' AND p.status='completed')", userId)!.c;
  const used = get<{ c: number }>("SELECT COUNT(*) c FROM gift_claims WHERE user_id = ? AND gift_id = 'refer'", userId)!.c;
  const avail = Math.floor(q / 2) - used;
  out.push({ id: 'refer', title: 'Refer Bonus', desc: 'Invite 2 more friends', reward: '₦50', icon: 'users', progress: avail > 0 ? 100 : Math.round(((q % 2) / 2) * 100), claimable: avail > 0, amount: 5000, key: `r${used + 1}` });

  // VIP tier from 30d turnover (informational)
  const turn = get<{ t: number }>('SELECT COALESCE(SUM(stake),0) t FROM bets WHERE user_id = ? AND created_at >= ?', userId, new Date(Date.now() - 30 * DAY).toISOString())!.t;
  let idx = 0;
  TIERS.forEach(([, min], i) => { if (turn >= min) idx = i; });
  const next = TIERS[idx + 1];
  out.push({ id: 'vip', title: 'VIP Status', desc: next ? `Reach ${next[0]} tier` : 'Top tier reached', reward: 'Exclusive Rewards', icon: 'crown', progress: next ? Math.min(100, Math.round(((turn - TIERS[idx][1]) / (next[1] - TIERS[idx][1])) * 100)) : 100, claimable: false, amount: 0, key: `tier-${TIERS[idx][0]}` });
  return out;
}

export function listGifts(userId: string) {
  if (isSelfExcluded(userId)) return [];
  return compute(userId).map(({ amount: _a, key, ...g }) => ({
    ...g,
    claimed: !!get('SELECT 1 FROM gift_claims WHERE user_id = ? AND gift_id = ? AND period_key = ?', userId, g.id, key),
  }));
}

export function claimGift(userId: string, giftId: string) {
  return tx(() => {
    if (isSelfExcluded(userId)) throw conflict('SELF_EXCLUDED', 'Self-excluded accounts cannot claim bonuses');
    const g = compute(userId).find((x) => x.id === giftId);
    if (!g) throw notFound('Gift not found');
    if (giftId === 'vip') throw badRequest('NOT_CLAIMABLE', 'VIP perks are applied automatically');
    if (!g.claimable) throw conflict('NOT_CLAIMABLE', 'Nothing to claim right now');
    run('INSERT INTO gift_claims (id, user_id, gift_id, period_key, amount, created_at) VALUES (?,?,?,?,?,?)', newId('gc'), userId, giftId, g.key, g.amount, nowIso());
    grantBonus(userId, g.amount, g.title, 'gift', giftId);
    return { giftId, bonusAdded: fromCents(g.amount) };
  });
}
