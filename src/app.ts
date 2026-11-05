import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { errorHandler, notFound } from './lib/errors.js';
import { handleProviderEvent, verifyWebhookSignature } from './services/payments.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { walletRouter } from './routes/wallet.js';
import { publicRouter } from './routes/public.js';
import { betsRouter, giftsRouter } from './routes/bets.js';
import { aviatorRouter } from './routes/aviator.js';
import { casinoRouter } from './routes/casino.js';
import { adminRouter } from './routes/admin.js';
import { jackpotRouter } from './routes/jackpot.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  app.use(rateLimit({ windowMs: 60_000, limit: config.isProd ? 300 : 5000, standardHeaders: true, legacyHeaders: false }));

  app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  const v1 = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } } });
  v1.use('/auth', authLimiter, authRouter);
  v1.use('/me', meRouter);
  v1.use('/wallet', walletRouter);
  v1.use('/bets', betsRouter);
  v1.use('/gifts', giftsRouter);
  v1.use('/aviator', aviatorRouter);
  v1.use('/casino', casinoRouter);
  v1.use('/jackpot', jackpotRouter);
  v1.use('/admin', adminRouter);
  v1.use('/', publicRouter);

  // payment gateway callbacks (server-to-server, HMAC signed)
  v1.post('/webhooks/payments', (req, res) => {
    if (!verifyWebhookSignature((req as any).rawBody, req.header('x-signature'))) return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } });
    const b = z.object({ providerRef: z.string(), status: z.enum(['completed', 'failed']) }).parse(req.body);
    handleProviderEvent(b.providerRef, b.status);
    res.json({ received: true });
  });

  app.use('/api/v1', v1);
  app.use((_req, _res, next) => next(notFound('Route not found')));
  app.use(errorHandler);
  return app;
}
