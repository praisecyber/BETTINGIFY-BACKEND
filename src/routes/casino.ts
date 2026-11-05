import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { moneyIn } from '../lib/money.js';
import { playRoulette, playSlots } from '../services/casino.js';
import { walletDto } from './me.js';

export const casinoRouter = Router();
casinoRouter.use(requireAuth);

casinoRouter.post('/play', idempotent, (req, res) => {
    const body = z.object({
        gameId: z.enum(['roulette', 'slots']),
        stake: moneyIn,
        betType: z.enum(['red', 'black', 'number']).optional(),
        number: z.number().int().min(0).max(36).optional(),
    }).superRefine((value, ctx) => {
        if (value.gameId === 'roulette' && !value.betType)
            ctx.addIssue({ code: 'custom', path: ['betType'], message: 'Choose red, black, or a number' });
        if (value.gameId === 'roulette' && value.betType === 'number' && value.number === undefined)
            ctx.addIssue({ code: 'custom', path: ['number'], message: 'Choose a number from 0 to 36' });
    }).parse(req.body);

    const result = body.gameId === 'roulette'
        ? playRoulette(req.user!.id, body.stake, body.betType === 'number'
            ? { type: 'number', number: body.number! }
            : { type: body.betType as 'red' | 'black' })
        : playSlots(req.user!.id, body.stake);
    res.status(201).json({ ...result, wallet: walletDto(req.user!.id) });
});