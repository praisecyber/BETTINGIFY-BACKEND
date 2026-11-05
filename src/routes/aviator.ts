import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { moneyIn } from '../lib/money.js';
import { aviator, verifyRound } from '../services/aviator.js';
import { walletDto } from './me.js';

export const aviatorRouter = Router();

export const displayName = (userId: string) => {
  const u = get<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM users WHERE id = ?', userId);
  return u ? `${u.first_name} ${u.last_name.charAt(0)}.` : 'Player';
};

aviatorRouter.get('/state', (_req, res) => res.json(aviator.snapshot()));

aviatorRouter.get('/history', (_req, res) => {
  res.json({ rounds: all<any>("SELECT id, crash_x100, crashed_at FROM aviator_rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 50").map((r) => ({ roundId: r.id, crashPoint: r.crash_x100 / 100, crashedAt: r.crashed_at })) });
});

aviatorRouter.get('/rounds/:id', (req, res) => {
  const v = verifyRound(Number(req.params.id));
  if (!v) throw notFound('Round not found');
  res.json(v);
});

aviatorRouter.post('/bet', requireAuth, (req, res) => {
  const b = z.object({ amount: moneyIn, autoCashout: z.number().min(1.01).max(1000).optional() }).parse(req.body);
  const r = aviator.placeBet(req.user!.id, displayName(req.user!.id), b.amount, b.autoCashout);
  res.status(201).json({ ...r, wallet: walletDto(req.user!.id) });
});

aviatorRouter.post('/bet/cancel', requireAuth, (req, res) => {
  aviator.cancelBet(req.user!.id);
  res.json({ wallet: walletDto(req.user!.id) });
});

aviatorRouter.post('/cashout', requireAuth, (req, res) => {
  const r = aviator.cashout(req.user!.id);
  res.json({ ...r, wallet: walletDto(req.user!.id) });
});

aviatorRouter.get('/my-bet', requireAuth, (req, res) => res.json({ bet: aviator.myBet(req.user!.id) }));
