import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { getJackpotState, buyJackpotEntries, getJackpotVerification } from '../services/jackpot.js';
import { getWallet } from '../services/wallet.js';
import { fromCents } from '../lib/money.js';

export const jackpotRouter = Router();

const optionalAuth: RequestHandler = (req, res, next) =>
  req.headers.authorization ? requireAuth(req, res, next) : next();

jackpotRouter.get('/', optionalAuth, (req, res) => {
  const userId = req.user?.id;
  res.json(getJackpotState(userId));
});

jackpotRouter.get('/draws/:id/verification', (req, res) => {
  const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
  res.json(getJackpotVerification(id));
});

jackpotRouter.post('/entries', requireAuth, idempotent, (req, res) => {
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(100).default(1) }).parse(req.body ?? {});
  const state = buyJackpotEntries(req.user!.id, quantity);
  const wallet = getWallet(req.user!.id);
  res.status(201).json({
    ...state,
    wallet: {
      balance: fromCents(wallet.cash + wallet.bonus),
      withdrawable: fromCents(wallet.cash),
      bonus: fromCents(wallet.bonus),
      bonusWagerRemaining: fromCents(wallet.wagerRemaining),
      currency: 'NGN',
    },
  });
});
