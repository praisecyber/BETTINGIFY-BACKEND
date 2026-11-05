import { EventEmitter } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { all, get, newId, nowIso, run, tx } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { fromCents } from '../lib/money.js';
import { creditReturn, debitStake, getWallet } from './wallet.js';
import { requireGamblingEligible } from './account.js';

const A = config.aviator;
export type Phase = 'betting' | 'flying' | 'crashed';

/** Provably fair: crash = f(HMAC_SHA256(serverSeed, roundId)). Hash of seed is published before the round. ~3% house edge (RTP 97%). */
export function crashFromSeed(serverSeed: string, roundId: number): number {
  const h = createHmac('sha256', serverSeed).update(String(roundId)).digest('hex');
  const r = parseInt(h.slice(0, 13), 16); // 52 bits
  const e = 2 ** 52;
  if (r % 33 === 0) return 100; // instant 1.00x crash
  return Math.min(A.maxMultiplierX100, Math.floor((100 * e - r) / (e - r)));
}
export const seedHash = (seed: string) => createHash('sha256').update(seed).digest('hex');
/** multiplier x100 after t ms of flight (same curve the frontend animates) */
export const multAt = (ms: number) => Math.floor((1 + Math.pow(ms / 1000, 1.5) * 0.4) * 100);
const timeFor = (x100: number) => Math.pow(((x100 / 100) - 1) / 0.4, 1 / 1.5) * 1000;

interface RBet { userId: string; betId: string; name: string; stake: number; cash: number; bonus: number; auto: number | null; cashedAt: number | null; payout: number }

export class AviatorEngine extends EventEmitter {
  phase: Phase = 'crashed';
  roundId = 0;
  private seed = '';
  hash = '';
  private crash = 100;
  private flightStart = 0;
  bettingEndsAt = 0;
  private bets = new Map<string, RBet>();
  history: number[] = [];
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  start() {
    if (this.running) return;
    this.running = true;
    this.recover();
    this.history = all<{ crash_x100: number }>("SELECT crash_x100 FROM aviator_rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 20").map((r) => r.crash_x100);
    this.newRound();
  }
  stop() { this.running = false; this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); this.timers = []; }

  /** After a crash/restart mid-round, refund any stakes still open from an interrupted round. */
  private recover() {
    tx(() => {
      for (const b of all<any>("SELECT * FROM bets WHERE kind = 'aviator' AND status = 'open'")) {
        run("UPDATE bets SET status = 'void', payout = stake, settled_at = ? WHERE id = ?", nowIso(), b.id);
        creditReturn(b.user_id, b.stake, { total: b.stake, cash: b.stake_cash, bonus: b.stake_bonus }, { type: 'bet_refund', refType: 'bet', refId: b.id, description: 'Aviator round interrupted' });
      }
      run("UPDATE aviator_rounds SET status = 'aborted' WHERE status IN ('betting','flying')");
    });
  }

  private newRound() {
    if (!this.running) return;
    this.seed = randomBytes(32).toString('hex');
    this.hash = seedHash(this.seed);
    const r = run('INSERT INTO aviator_rounds (server_seed, seed_hash, crash_x100, status, created_at) VALUES (?,?,?,?,?)', this.seed, this.hash, 0, 'betting', nowIso());
    this.roundId = Number(r.lastInsertRowid);
    this.crash = crashFromSeed(this.seed, this.roundId);
    run('UPDATE aviator_rounds SET crash_x100 = ? WHERE id = ?', this.crash, this.roundId);
    this.bets.clear();
    this.phase = 'betting';
    this.bettingEndsAt = Date.now() + A.bettingMs;
    this.emit('event', { type: 'betting', ...this.snapshot() });
    this.timers.push(setTimeout(() => this.fly(), A.bettingMs));
  }

  private fly() {
    if (!this.running) return;
    this.phase = 'flying';
    this.flightStart = Date.now();
    run("UPDATE aviator_rounds SET status = 'flying' WHERE id = ?", this.roundId);
    this.emit('event', { type: 'flying', roundId: this.roundId });
    const crashIn = timeFor(this.crash);
    const iv = setInterval(() => {
      const m = Math.min(multAt(Date.now() - this.flightStart), this.crash - 1 >= 100 ? this.crash - 1 : 100);
      this.processAutos(m);
      this.emit('event', { type: 'tick', multiplier: m / 100 });
    }, A.tickMs);
    this.timers.push(iv);
    this.timers.push(setTimeout(() => { clearInterval(iv); this.doCrash(); }, crashIn));
  }

  private processAutos(m: number) {
    for (const b of this.bets.values())
      if (b.cashedAt === null && b.auto !== null && b.auto <= m && b.auto < this.crash) this.cashAt(b, b.auto);
  }

  private doCrash() {
    this.processAutos(this.crash - 1); // anyone whose auto target was below the crash point still gets paid
    this.phase = 'crashed';
    tx(() => {
      run("UPDATE aviator_rounds SET status = 'crashed', crashed_at = ? WHERE id = ?", nowIso(), this.roundId);
      for (const b of this.bets.values())
        if (b.cashedAt === null) run("UPDATE bets SET status = 'lost', settled_at = ? WHERE id = ? AND status = 'open'", nowIso(), b.betId);
    });
    this.history.unshift(this.crash);
    this.history = this.history.slice(0, 20);
    this.emit('event', { type: 'crashed', roundId: this.roundId, crashPoint: this.crash / 100, serverSeed: this.seed, players: this.players() });
    for (const b of this.bets.values()) if (b.cashedAt === null) this.emit('user', b.userId, { type: 'lost', roundId: this.roundId, stake: fromCents(b.stake) });
    this.timers.push(setTimeout(() => this.newRound(), A.crashPauseMs));
  }

  private cashAt(b: RBet, m: number) {
    const payout = Math.floor((b.stake * m) / 100);
    tx(() => {
      const r = run("UPDATE bets SET status = 'won', payout = ?, odds = ?, selection_label = ?, settled_at = ? WHERE id = ? AND status = 'open'", payout, m * 10, `Cash Out x${(m / 100).toFixed(2)}`, nowIso(), b.betId);
      if (r.changes === 0) return;
      creditReturn(b.userId, payout, { total: b.stake, cash: b.cash, bonus: b.bonus }, { type: 'win', refType: 'bet', refId: b.betId, description: `Aviator x${(m / 100).toFixed(2)}` });
    });
    b.cashedAt = m; b.payout = payout;
    this.emit('event', { type: 'players', players: this.players() });
    const w = getWallet(b.userId);
    this.emit('user', b.userId, { type: 'cashed_out', multiplier: m / 100, payout: fromCents(payout), balance: fromCents(w.cash + w.bonus) });
  }

  placeBet(userId: string, name: string, stake: number, autoCashout?: number) {
    if (this.phase !== 'betting' || Date.now() >= this.bettingEndsAt) throw conflict('BETTING_CLOSED', 'Betting is closed for this round');
    if (stake < A.minBetCents || stake > A.maxBetCents) throw badRequest('STAKE_OUT_OF_RANGE', `Stake must be between ${A.minBetCents / 100} and ${A.maxBetCents / 100}`);
    if (this.bets.has(userId)) throw conflict('ALREADY_BET', 'You already have a bet in this round');
    const auto = autoCashout ? Math.round(autoCashout * 100) : null;
    if (auto !== null && auto < 101) throw badRequest('BAD_AUTO', 'Auto cash-out must be above 1.00x');
    const betId = newId('bet');
    const { fromCash, fromBonus } = tx(() => {
      requireGamblingEligible(userId);
      const s = debitStake(userId, stake, { refType: 'bet', refId: betId, description: `Aviator round #${this.roundId}` });
      run(`INSERT INTO bets (id, user_id, kind, match_label, selection_label, odds, stake, stake_cash, stake_bonus, potential, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, betId, userId, 'aviator', 'Aviator', `Round #${this.roundId}`, 0, stake, s.fromCash, s.fromBonus, 0, nowIso());
      return s;
    });
    this.bets.set(userId, { userId, betId, name, stake, cash: fromCash, bonus: fromBonus, auto: auto && auto > 100 ? auto : null, cashedAt: null, payout: 0 });
    this.emit('event', { type: 'players', players: this.players() });
    return { betId, roundId: this.roundId };
  }

  /** Cancel before the flight starts; full refund. */
  cancelBet(userId: string) {
    const b = this.bets.get(userId);
    if (!b || this.phase !== 'betting') throw conflict('CANNOT_CANCEL', 'No cancellable bet');
    tx(() => {
      run("UPDATE bets SET status = 'void', payout = stake, settled_at = ? WHERE id = ?", nowIso(), b.betId);
      creditReturn(userId, b.stake, { total: b.stake, cash: b.cash, bonus: b.bonus }, { type: 'bet_refund', refType: 'bet', refId: b.betId, description: 'Aviator bet cancelled' });
    });
    this.bets.delete(userId);
    this.emit('event', { type: 'players', players: this.players() });
  }

  cashout(userId: string) {
    const b = this.bets.get(userId);
    if (!b || this.phase !== 'flying') throw conflict('CANNOT_CASH_OUT', 'No active bet to cash out');
    if (b.cashedAt !== null) throw conflict('ALREADY_CASHED_OUT', 'Already cashed out');
    const m = multAt(Date.now() - this.flightStart); // server clock is authoritative
    if (m >= this.crash) throw conflict('TOO_LATE', 'The plane already crashed');
    this.cashAt(b, m);
    return { multiplier: m / 100, payout: fromCents(b.payout) };
  }

  players() {
    return [...this.bets.values()].map((b) => ({ name: b.name, stake: fromCents(b.stake), cashedOutAt: b.cashedAt === null ? null : b.cashedAt / 100, win: fromCents(b.payout) }));
  }

  myBet(userId: string) {
    const b = this.bets.get(userId);
    return b ? { betId: b.betId, stake: fromCents(b.stake), autoCashout: b.auto ? b.auto / 100 : null, cashedOutAt: b.cashedAt ? b.cashedAt / 100 : null, payout: fromCents(b.payout) } : null;
  }

  snapshot() {
    return {
      roundId: this.roundId, phase: this.phase, seedHash: this.hash,
      bettingEndsInMs: this.phase === 'betting' ? Math.max(0, this.bettingEndsAt - Date.now()) : 0,
      multiplier: this.phase === 'flying' ? multAt(Date.now() - this.flightStart) / 100 : this.phase === 'crashed' ? this.crash / 100 : 1,
      history: this.history.map((x) => x / 100), players: this.players(),
    };
  }
}

export const aviator = new AviatorEngine();

export function verifyRound(id: number) {
  const r = get<{ id: number; server_seed: string; seed_hash: string; crash_x100: number; status: string }>('SELECT * FROM aviator_rounds WHERE id = ?', id);
  if (!r) return null;
  if (r.status !== 'crashed') return { roundId: r.id, seedHash: r.seed_hash, status: r.status, revealed: false };
  return { roundId: r.id, seedHash: r.seed_hash, serverSeed: r.server_seed, crashPoint: r.crash_x100 / 100, status: r.status, revealed: true,
    howToVerify: 'sha256(serverSeed) must equal seedHash; crash = f(HMAC_SHA256(key=serverSeed, msg=roundId)) — see README' };
}
