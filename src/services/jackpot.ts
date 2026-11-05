import { createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { all, get, newId, nowIso, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { fromCents } from '../lib/money.js';
import { requireGamblingEligible } from './account.js';
import { creditCash, debitCash } from './wallet.js';

interface DrawRow {
  id: string;
  period_start: string;
  closes_at: string;
  status: 'open' | 'drawn' | 'void';
  server_seed: string;
  seed_hash: string;
  entry_ids: string | null;
  selection_counter: number | null;
  winning_entry_index: number | null;
  winning_entry_id: string | null;
  winner_user_id: string | null;
  prize: number;
  created_at: string;
  drawn_at: string | null;
}

interface EntryRow { id: string; user_id: string; amount: number }

function currentPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { start: start.toISOString(), closesAt: end.toISOString() };
}

function getOrCreateCurrentDraw() {
  const period = currentPeriod();
  let draw = get<DrawRow>('SELECT * FROM jackpot_draws WHERE period_start = ?', period.start);
  if (!draw) {
    const seed = randomBytes(32).toString('hex');
    const id = newId('jackpot');
    run(`INSERT OR IGNORE INTO jackpot_draws
      (id,period_start,closes_at,status,server_seed,seed_hash,created_at)
      VALUES (?,?,?,'open',?,?,?)`,
    id, period.start, period.closesAt, seed, createHash('sha256').update(seed).digest('hex'), nowIso());
    draw = get<DrawRow>('SELECT * FROM jackpot_draws WHERE period_start = ?', period.start);
  }
  if (!draw) throw new Error('Unable to create the current jackpot draw');
  return draw;
}

function winningIndex(draw: DrawRow, entries: EntryRow[]) {
  const bound = 1n << 52n;
  const count = BigInt(entries.length);
  const limit = bound - (bound % count);
  for (let counter = 0; counter < 100; counter++) {
    const digest = createHmac('sha256', draw.server_seed)
      .update(`${draw.id}:${entries.map((entry) => entry.id).join(',')}:${counter}`)
      .digest('hex');
    const sample = BigInt(`0x${digest.slice(0, 13)}`);
    if (sample < limit) return { index: Number(sample % count), counter };
  }
  throw new Error('Unable to select a jackpot winner');
}

function settleExpiredDraws(now = Date.now()) {
  const nowText = new Date(now).toISOString();
  const expired = all<DrawRow>(
    "SELECT * FROM jackpot_draws WHERE status = 'open' AND closes_at <= ? ORDER BY closes_at",
    nowText,
  );
  for (const draw of expired) {
    tx(() => {
      const current = get<DrawRow>("SELECT * FROM jackpot_draws WHERE id = ? AND status = 'open'", draw.id);
      if (!current) return;
      const entries = all<EntryRow>('SELECT id,user_id,amount FROM jackpot_entries WHERE draw_id = ? ORDER BY id', draw.id);
      if (entries.length === 0) {
        run("UPDATE jackpot_draws SET status = 'void', drawn_at = ? WHERE id = ? AND status = 'open'", nowText, draw.id);
        return;
      }
      const selection = winningIndex(current, entries);
      const winner = entries[selection.index];
      const prize = entries.reduce((sum, entry) => sum + entry.amount, 0);
      const update = run(`UPDATE jackpot_draws
        SET status = 'drawn', entry_ids = ?, selection_counter = ?, winning_entry_index = ?,
            winning_entry_id = ?, winner_user_id = ?, prize = ?, drawn_at = ?
        WHERE id = ? AND status = 'open'`,
      JSON.stringify(entries.map((entry) => entry.id)), selection.counter, selection.index,
      winner.id, winner.user_id, prize, nowText, draw.id);
      if (update.changes === 1) {
        creditCash(winner.user_id, prize, {
          type: 'jackpot_win',
          refType: 'jackpot',
          refId: draw.id,
          description: 'Weekly jackpot prize',
        });
      }
    });
  }
}

export function settleDueJackpotDraws() {
  if (config.jackpotEnabled) settleExpiredDraws();
}

const drawDto = (draw: DrawRow, userId?: string) => {
  const entries = get<{ count: number; pool: number }>(
    'SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS pool FROM jackpot_entries WHERE draw_id = ?',
    draw.id,
  )!;
  const myEntries = userId
    ? get<{ count: number }>('SELECT COUNT(*) AS count FROM jackpot_entries WHERE draw_id = ? AND user_id = ?', draw.id, userId)!.count
    : undefined;
  return {
    id: draw.id,
    periodStart: draw.period_start,
    closesAt: draw.closes_at,
    status: draw.status,
    seedHash: draw.seed_hash,
    revealedSeed: draw.status === 'open' ? null : draw.server_seed,
    winningEntryIndex: draw.winning_entry_index,
    winningEntryId: draw.winning_entry_id,
    entryCount: entries.count,
    pool: fromCents(entries.pool),
    prize: fromCents(draw.prize),
    hasWinner: !!draw.winner_user_id,
    myEntries,
    drawnAt: draw.drawn_at,
  };
};

export function getJackpotState(userId?: string) {
  if (!config.jackpotEnabled) {
    const latest = all<DrawRow>("SELECT * FROM jackpot_draws WHERE status != 'open' ORDER BY period_start DESC LIMIT 10")
      .map((draw) => drawDto(draw));
    return {
      enabled: false,
      ticketPrice: fromCents(config.jackpotTicketCents),
      maxEntriesPerUser: config.jackpotMaxEntriesPerUser,
      draw: null,
      latest,
    };
  }

  const draw = getOrCreateCurrentDraw();
  settleExpiredDraws();
  const current = get<DrawRow>('SELECT * FROM jackpot_draws WHERE id = ?', draw.id)!;
  const latest = all<DrawRow>('SELECT * FROM jackpot_draws WHERE status != \'open\' ORDER BY period_start DESC LIMIT 10')
    .map((item) => drawDto(item));
  return {
    enabled: true,
    ticketPrice: fromCents(config.jackpotTicketCents),
    maxEntriesPerUser: config.jackpotMaxEntriesPerUser,
    draw: drawDto(current, userId),
    latest,
  };
}

export function getJackpotVerification(drawId: string) {
  const draw = get<DrawRow>('SELECT * FROM jackpot_draws WHERE id = ?', drawId);
  if (!draw) throw notFound('Jackpot draw not found');
  if (draw.status === 'open') throw conflict('DRAW_NOT_COMPLETE', 'The draw can be verified after it closes');
  return {
    drawId: draw.id,
    status: draw.status,
    seedHash: draw.seed_hash,
    revealedSeed: draw.server_seed,
    entryIds: draw.entry_ids ? JSON.parse(draw.entry_ids) as string[] : [],
    selectionCounter: draw.selection_counter,
    winningEntryIndex: draw.winning_entry_index,
    winningEntryId: draw.winning_entry_id,
    algorithm: 'Sort ticket IDs lexicographically; for counter=0.., compute HMAC-SHA256(key=serverSeed, message=drawId:comma-separated-ticket-IDs:counter). Read the first 13 hex digits as an integer, reject values >= 2^52 - (2^52 mod ticketCount), and choose value mod ticketCount.',
  };
}

export function buyJackpotEntries(userId: string, quantity: number) {
  if (!config.jackpotEnabled) throw conflict('JACKPOT_DISABLED', 'Jackpot entries are not enabled');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > config.jackpotMaxEntriesPerUser)
    throw badRequest('INVALID_ENTRY_COUNT', `Choose between 1 and ${config.jackpotMaxEntriesPerUser} entries`);
  const draw = getOrCreateCurrentDraw();
  settleExpiredDraws();
  return tx(() => {
    const current = get<DrawRow>('SELECT * FROM jackpot_draws WHERE id = ?', draw.id);
    if (!current || current.status !== 'open' || Date.parse(current.closes_at) <= Date.now())
      throw conflict('JACKPOT_CLOSED', 'This week’s jackpot is closed; try the next draw');
    requireGamblingEligible(userId);
    const prior = get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM jackpot_entries WHERE draw_id = ? AND user_id = ?',
      current.id,
      userId,
    )!.count;
    if (prior + quantity > config.jackpotMaxEntriesPerUser)
      throw badRequest('ENTRY_LIMIT_REACHED', `You can buy up to ${config.jackpotMaxEntriesPerUser} entries per draw`);
    const amount = config.jackpotTicketCents * quantity;
    debitCash(userId, amount, {
      type: 'jackpot_entry',
      refType: 'jackpot',
      refId: current.id,
      description: `${quantity} weekly jackpot ${quantity === 1 ? 'entry' : 'entries'}`,
    });
    for (let i = 0; i < quantity; i++) {
      run('INSERT INTO jackpot_entries (id,draw_id,user_id,amount,created_at) VALUES (?,?,?,?,?)',
        newId('jentry'), current.id, userId, config.jackpotTicketCents, nowIso());
    }
    return getJackpotState(userId);
  });
}
