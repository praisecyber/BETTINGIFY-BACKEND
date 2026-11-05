import { config } from '../config.js';
import { all, get, newId, nowIso, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { fromCents, fromMilli } from '../lib/money.js';
import { creditReturn, debitStake } from './wallet.js';
import { requireGamblingEligible } from './account.js';

export type Selection = 'home' | 'draw' | 'away';
export interface MatchRow {
  id: string; sport: string; league: string; home: string; away: string; starts_at: string;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled'; score: string | null;
  odds_home: number; odds_draw: number; odds_away: number; result: Selection | null;
}
export interface BetRow {
  id: string; user_id: string; kind: 'sport' | 'aviator'; match_id: string | null; match_label: string;
  selection: Selection | null; selection_label: string; odds: number; stake: number; stake_cash: number;
  stake_bonus: number; potential: number; status: 'open' | 'won' | 'lost' | 'cashed_out' | 'void';
  payout: number; created_at: string; settled_at: string | null;
}
export interface BetLegInput { matchId: string; selection: Selection; expectedOdds?: number }

export const matchDto = (m: MatchRow) => ({
  id: m.id, sport: m.sport, league: m.league, home: m.home, away: m.away, startsAt: m.starts_at,
  status: m.status, isLive: m.status === 'live', score: m.score,
  odds: { home: fromMilli(m.odds_home), draw: fromMilli(m.odds_draw), away: fromMilli(m.odds_away) },
  result: m.result,
});

const oddsFor = (m: MatchRow, s: Selection) => (s === 'home' ? m.odds_home : s === 'draw' ? m.odds_draw : m.odds_away);
const selLabel = (m: MatchRow, s: Selection) => (s === 'home' ? `${m.home} Win` : s === 'away' ? `${m.away} Win` : 'Draw');

export function cashoutOffer(b: BetRow, m: MatchRow | undefined): number | null {
  if (b.status !== 'open' || b.kind !== 'sport' || !m || !b.selection) return null;
  if (m.status !== 'scheduled' && m.status !== 'live') return null;
  const now = oddsFor(m, b.selection);
  if (now <= 0) return null;
  const offer = Math.floor((b.potential * 1000 / now) * (config.cashoutMarginPct / 100));
  return Math.max(1, Math.min(offer, b.potential - 1));
}

export function betDto(b: BetRow) {
  const m = b.match_id ? get<MatchRow>('SELECT * FROM matches WHERE id = ?', b.match_id) : undefined;
  const offer = cashoutOffer(b, m);
  return {
    id: b.id, kind: b.kind, matchId: b.match_id, match: b.match_label, selection: b.selection_label,
    odds: fromMilli(b.odds), stake: fromCents(b.stake), potential: fromCents(b.potential),
    status: b.status, payout: fromCents(b.payout), cashoutOffer: offer === null ? null : fromCents(offer),
    date: b.created_at, settledAt: b.settled_at,
    legs: b.match_id ? undefined : all<{ match_id: string; match_label: string; selection: Selection; selection_label: string; odds: number; status: string; result: Selection | null; score: string | null }>(
      `SELECT l.match_id,m.home || ' vs ' || m.away AS match_label,l.selection,
        CASE l.selection WHEN 'home' THEN m.home || ' Win' WHEN 'away' THEN m.away || ' Win' ELSE 'Draw' END AS selection_label,
        l.odds,l.status,m.result,m.score FROM bet_legs l JOIN matches m ON m.id=l.match_id WHERE l.bet_id=? ORDER BY l.rowid`,
      b.id,
    ).map((leg) => ({ matchId: leg.match_id, match: leg.match_label, selection: leg.selection_label, odds: fromMilli(leg.odds), status: leg.status, result: leg.result, score: leg.score })),
  };
}

export function placeBet(userId: string, i: { matchId: string; selection: Selection; stake: number; expectedOdds?: number }) {
  if (i.stake < config.minStakeCents || i.stake > config.maxStakeCents)
    throw badRequest('STAKE_OUT_OF_RANGE', `Stake must be between ${config.minStakeCents / 100} and ${config.maxStakeCents / 100}`);
  return tx(() => {
    requireGamblingEligible(userId);
    const m = get<MatchRow>('SELECT * FROM matches WHERE id = ?', i.matchId);
    if (!m) throw notFound('Match not found');
    if (m.status !== 'scheduled' && m.status !== 'live') throw conflict('MARKET_CLOSED', 'Betting is closed for this match');
    const odds = oddsFor(m, i.selection);
    if (odds <= 0) throw badRequest('NO_MARKET', 'This selection is not available');
    if (i.expectedOdds !== undefined && Math.round(i.expectedOdds * 1000) !== odds)
      throw conflict('ODDS_CHANGED', 'Odds have changed', { currentOdds: fromMilli(odds) });
    const id = newId('bet');
    const label = `${m.home} vs ${m.away}`;
    const { fromCash, fromBonus } = debitStake(userId, i.stake, { refType: 'bet', refId: id, description: label });
    const potential = Math.floor((i.stake * odds) / 1000);
    run(`INSERT INTO bets (id, user_id, kind, match_id, match_label, selection, selection_label, odds, stake, stake_cash, stake_bonus, potential, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, userId, 'sport', m.id, label, i.selection, selLabel(m, i.selection), odds, i.stake, fromCash, fromBonus, potential, nowIso());
    return get<BetRow>('SELECT * FROM bets WHERE id = ?', id)!;
  });
}

export function placeAccumulator(userId: string, legs: BetLegInput[], stake: number) {
  if (legs.length < 2 || legs.length > 20) throw badRequest('INVALID_ACCUMULATOR', 'An accumulator must contain between 2 and 20 selections');
  if (new Set(legs.map((leg) => leg.matchId)).size !== legs.length)
    throw badRequest('DUPLICATE_MATCH', 'An accumulator can only contain one selection per match');
  if (stake < config.minStakeCents || stake > config.maxStakeCents)
    throw badRequest('STAKE_OUT_OF_RANGE', `Stake must be between ${config.minStakeCents / 100} and ${config.maxStakeCents / 100}`);
  return tx(() => {
    requireGamblingEligible(userId);
    const checked = legs.map((leg) => {
      const match = get<MatchRow>('SELECT * FROM matches WHERE id = ?', leg.matchId);
      if (!match) throw notFound('Match not found');
      if (match.status !== 'scheduled' && match.status !== 'live') throw conflict('MARKET_CLOSED', 'Betting is closed for a match in this accumulator');
      const odds = oddsFor(match, leg.selection);
      if (odds <= 0) throw badRequest('NO_MARKET', 'A selection in this accumulator is not available');
      if (leg.expectedOdds !== undefined && Math.round(leg.expectedOdds * 1000) !== odds)
        throw conflict('ODDS_CHANGED', 'Odds have changed', { matchId: match.id, currentOdds: fromMilli(odds) });
      return { match, selection: leg.selection, odds };
    });
    let combinedOdds = 1000n;
    for (const leg of checked) {
      const nextOdds = combinedOdds * BigInt(leg.odds) / 1000n;
      if (nextOdds > BigInt(Number.MAX_SAFE_INTEGER))
        throw badRequest('PAYOUT_TOO_LARGE', 'Combined odds exceed the supported payout limit');
      combinedOdds = nextOdds;
    }
    const potentialCents = BigInt(stake) * combinedOdds / 1000n;
    if (potentialCents > BigInt(Number.MAX_SAFE_INTEGER))
      throw badRequest('PAYOUT_TOO_LARGE', 'Potential return exceeds the supported payout limit');
    const potential = Number(potentialCents);
    const id = newId('bet');
    const label = `${checked.length}-selection accumulator`;
    const stakeParts = debitStake(userId, stake, { refType: 'bet', refId: id, description: label });
    run(`INSERT INTO bets (id,user_id,kind,match_id,match_label,selection,selection_label,odds,stake,stake_cash,stake_bonus,potential,created_at)
         VALUES (?,?, 'sport',NULL,?,NULL,?,?,?,?,?,?,?)`,
      id, userId, label, label, Number(combinedOdds), stake, stakeParts.fromCash, stakeParts.fromBonus, potential, nowIso());
    for (const leg of checked) run(
      'INSERT INTO bet_legs (id,bet_id,match_id,selection,odds) VALUES (?,?,?,?,?)',
      newId('leg'), id, leg.match.id, leg.selection, leg.odds,
    );
    return get<BetRow>('SELECT * FROM bets WHERE id = ?', id)!;
  });
}

const stakeOf = (b: BetRow) => ({ total: b.stake, cash: b.stake_cash, bonus: b.stake_bonus });

export function cashOut(userId: string, betId: string, expected?: number) {
  return tx(() => {
    const b = get<BetRow>('SELECT * FROM bets WHERE id = ? AND user_id = ?', betId, userId);
    if (!b) throw notFound('Bet not found');
    const m = b.match_id ? get<MatchRow>('SELECT * FROM matches WHERE id = ?', b.match_id) : undefined;
    const offer = cashoutOffer(b, m);
    if (offer === null) throw conflict('CASHOUT_UNAVAILABLE', 'Cash out is not available for this bet');
    if (expected !== undefined && expected !== offer)
      throw conflict('OFFER_CHANGED', 'Cash out value changed', { currentOffer: fromCents(offer) });
    const r = run("UPDATE bets SET status = 'cashed_out', payout = ?, settled_at = ? WHERE id = ? AND status = 'open'", offer, nowIso(), betId);
    if (r.changes === 0) throw conflict('NOT_OPEN', 'Bet is no longer open');
    creditReturn(userId, offer, stakeOf(b), { type: 'cashout', refType: 'bet', refId: betId, description: `Cash out: ${b.match_label}` });
    return get<BetRow>('SELECT * FROM bets WHERE id = ?', betId)!;
  });
}

export function settleMatch(matchId: string, result: Selection, score?: string) {
  return tx(() => {
    const m = get<MatchRow>('SELECT * FROM matches WHERE id = ?', matchId);
    if (!m) throw notFound('Match not found');
    if (m.status === 'finished' || m.status === 'cancelled') throw conflict('ALREADY_SETTLED', 'Match already closed');
    if (result === 'draw' && m.odds_draw <= 0) throw badRequest('NO_DRAW', 'This match has no draw market');
    run("UPDATE matches SET status = 'finished', result = ?, score = COALESCE(?, score) WHERE id = ?", result, score ?? null, matchId);
    const open = all<BetRow>("SELECT * FROM bets WHERE match_id = ? AND status = 'open'", matchId);
    let won = 0, lost = 0, paid = 0;
    for (const b of open) {
      if (b.selection === result) {
        run("UPDATE bets SET status = 'won', payout = ?, settled_at = ? WHERE id = ?", b.potential, nowIso(), b.id);
        creditReturn(b.user_id, b.potential, stakeOf(b), { type: 'win', refType: 'bet', refId: b.id, description: b.match_label });
        won++; paid += b.potential;
      } else {
        run("UPDATE bets SET status = 'lost', settled_at = ? WHERE id = ?", nowIso(), b.id);
        lost++;
      }
    }
    const accumulators = all<BetRow>(`SELECT DISTINCT b.* FROM bets b JOIN bet_legs l ON l.bet_id=b.id
      WHERE l.match_id=? AND b.match_id IS NULL AND b.kind='sport' AND b.status='open' AND l.status='open'`, matchId);
    for (const b of accumulators) {
      const leg = get<{ selection: Selection }>('SELECT selection FROM bet_legs WHERE bet_id=? AND match_id=?', b.id, matchId)!;
      const wonLeg = leg.selection === result;
      run("UPDATE bet_legs SET status=? WHERE bet_id=? AND match_id=? AND status='open'", wonLeg ? 'won' : 'lost', b.id, matchId);
      if (!wonLeg) {
        run("UPDATE bets SET status='lost',settled_at=? WHERE id=? AND status='open'", nowIso(), b.id);
        run("UPDATE bet_legs SET status='void' WHERE bet_id=? AND status='open'", b.id);
        lost++;
      } else {
        const remaining = get<{ count: number }>("SELECT COUNT(*) AS count FROM bet_legs WHERE bet_id=? AND status='open'", b.id)!.count;
        if (remaining === 0) {
          run("UPDATE bets SET status='won',payout=?,settled_at=? WHERE id=? AND status='open'", b.potential, nowIso(), b.id);
          creditReturn(b.user_id, b.potential, stakeOf(b), { type: 'win', refType: 'bet', refId: b.id, description: b.match_label });
          won++;
          paid += b.potential;
        }
      }
    }
    return { settled: open.length + accumulators.length, won, lost, totalPaid: fromCents(paid) };
  });
}

export function cancelMatch(matchId: string) {
  return tx(() => {
    const m = get<MatchRow>('SELECT * FROM matches WHERE id = ?', matchId);
    if (!m) throw notFound('Match not found');
    if (m.status === 'finished' || m.status === 'cancelled') throw conflict('ALREADY_SETTLED', 'Match already closed');
    run("UPDATE matches SET status = 'cancelled' WHERE id = ?", matchId);
    const open = all<BetRow>("SELECT * FROM bets WHERE match_id = ? AND status = 'open'", matchId);
    for (const b of open) {
      run("UPDATE bets SET status = 'void', payout = stake, settled_at = ? WHERE id = ?", nowIso(), b.id);
      creditReturn(b.user_id, b.stake, stakeOf(b), { type: 'bet_refund', refType: 'bet', refId: b.id, description: `Refund: ${b.match_label}` });
    }
    const accumulators = all<BetRow>(`SELECT DISTINCT b.* FROM bets b JOIN bet_legs l ON l.bet_id=b.id
      WHERE l.match_id=? AND b.match_id IS NULL AND b.kind='sport' AND b.status='open' AND l.status='open'`, matchId);
    for (const b of accumulators) {
      run("UPDATE bets SET status='void',payout=stake,settled_at=? WHERE id=? AND status='open'", nowIso(), b.id);
      run("UPDATE bet_legs SET status='void' WHERE bet_id=? AND status='open'", b.id);
      creditReturn(b.user_id, b.stake, stakeOf(b), { type: 'bet_refund', refType: 'bet', refId: b.id, description: `Refund: ${b.match_label}` });
    }
    return { voided: open.length + accumulators.length };
  });
}
