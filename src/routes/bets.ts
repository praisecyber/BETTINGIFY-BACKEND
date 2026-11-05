import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { moneyIn } from '../lib/money.js';
import { betDto, cashOut, placeAccumulator, placeBet, type BetRow } from '../services/bets.js';
import { claimGift, listGifts } from '../services/gifts.js';
import { walletDto } from './me.js';

export const betsRouter = Router();
betsRouter.use(requireAuth);

betsRouter.post('/', idempotent, (req, res) => {
  const b = z.object({ matchId: z.string(), selection: z.enum(['home', 'draw', 'away']), stake: moneyIn, expectedOdds: z.number().positive().optional() }).parse(req.body);
  const bet = placeBet(req.user!.id, b);
  res.status(201).json({ bet: betDto(bet), wallet: walletDto(req.user!.id) });
});

betsRouter.post('/accumulator', idempotent, (req, res) => {
  const b = z.object({
    legs: z.array(z.object({
      matchId: z.string().min(1),
      selection: z.enum(['home', 'draw', 'away']),
      expectedOdds: z.number().positive().optional(),
    })).min(2).max(20),
    stake: moneyIn,
  }).parse(req.body);
  const bet = placeAccumulator(req.user!.id, b.legs, b.stake);
  res.status(201).json({ bet: betDto(bet), wallet: walletDto(req.user!.id) });
});

betsRouter.get('/', (req, res) => {
  const q = z.object({ status: z.enum(['open', 'settled', 'won', 'lost', 'cashed_out', 'void']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  let where = 'user_id = ?'; const p: (string | number)[] = [req.user!.id];
  if (q.status === 'settled') where += " AND status != 'open'";
  else if (q.status) { where += ' AND status = ?'; p.push(q.status); }
  const rows = all<BetRow>(`SELECT * FROM bets WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...p, q.limit);
  res.json({ bets: rows.map(betDto) });
});

betsRouter.get('/:id', (req, res) => {
  const b = get<BetRow>('SELECT * FROM bets WHERE id = ? AND user_id = ?', String(req.params.id), req.user!.id);
  if (!b) throw notFound('Bet not found');
  res.json(betDto(b));
});

betsRouter.post('/:id/cashout', idempotent, (req, res) => {
  const b = z.object({ expectedValue: z.number().positive().optional() }).parse(req.body ?? {});
  const bet = cashOut(req.user!.id, String(req.params.id), b.expectedValue === undefined ? undefined : Math.round(b.expectedValue * 100));
  res.json({ bet: betDto(bet), wallet: walletDto(req.user!.id) });
});

export const giftsRouter = Router();
giftsRouter.use(requireAuth);
giftsRouter.get('/', (req, res) => res.json({ gifts: listGifts(req.user!.id) }));
giftsRouter.post('/:id/claim', (req, res) => res.json({ ...claimGift(req.user!.id, String(req.params.id)), wallet: walletDto(req.user!.id) }));
