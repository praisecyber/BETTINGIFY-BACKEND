import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { all, get } from '../db.js';
import { notFound } from '../lib/errors.js';
import { matchDto, type MatchRow } from '../services/bets.js';
import { getOdds, getOddsSports } from '../services/oddsFeed.js';
import { getSportApiDay, getSportApiTeamLogo } from '../services/sportApiFeed.js';
import { getSportsDay } from '../services/sportsFeed.js';

export const publicRouter = Router();

publicRouter.get('/sports-feed/events', async (req, res, next) => {
  try {
    const q = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(new Date().toISOString().slice(0, 10)),
      sport: z.string().trim().min(2).max(40).default('Soccer'),
    }).parse(req.query);
    if (!Number.isFinite(Date.parse(`${q.date}T00:00:00.000Z`))
      || new Date(`${q.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== q.date) {
      return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'Date must be a valid YYYY-MM-DD calendar date' } });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getSportsDay(q.date, q.sport));
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/sports-feed/sportapi/events', async (req, res, next) => {
  try {
    const q = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(new Date().toISOString().slice(0, 10)),
    }).parse(req.query);
    if (!Number.isFinite(Date.parse(`${q.date}T00:00:00.000Z`))
      || new Date(`${q.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== q.date) {
      return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'Date must be a valid YYYY-MM-DD calendar date' } });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getSportApiDay(q.date));
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/sports-feed/sportapi/teams/:id/logo', async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.coerce.number().int().positive().max(100_000_000) }).parse(req.params);
    const logo = await getSportApiTeamLogo(id);
    res.set('Content-Type', logo.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(logo.body);
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/sports-feed/odds/sports', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'private, max-age=900');
    res.json({ provider: 'The Odds API', sports: await getOddsSports() });
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/sports-feed/odds', rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'ODDS_FEED_RATE_LIMITED', message: 'Please wait a minute before requesting more provider odds' } },
}), async (req, res, next) => {
  try {
    const q = z.object({
      sportKey: z.string().regex(/^[a-z0-9_]{1,60}$/i).default('soccer_epl'),
      regions: z.string().regex(/^(us|us2|uk|au|eu)(,(us|us2|uk|au|eu))*$/).default('us,us2,uk,eu,au'),
      markets: z.string().regex(/^(h2h|spreads|totals|outrights)(,(h2h|spreads|totals|outrights))*$/).default('h2h'),
    }).parse(req.query);
    res.set('Cache-Control', 'private, max-age=60');
    res.json(await getOdds(q.sportKey, q.regions, q.markets));
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/matches', (req, res) => {
  const q = z.object({ sport: z.string().optional(), live: z.enum(['true', 'false']).optional(), q: z.string().max(60).optional(), status: z.enum(['scheduled', 'live', 'finished', 'cancelled']).optional() }).parse(req.query);
  const where: string[] = []; const p: (string | number)[] = [];
  if (q.sport) { where.push('LOWER(sport) = LOWER(?)'); p.push(q.sport); }
  if (q.live === 'true') where.push("status = 'live'");
  if (q.status) { where.push('status = ?'); p.push(q.status); } else where.push("status IN ('scheduled','live')");
  if (q.q) { where.push('(LOWER(home) LIKE ? OR LOWER(away) LIKE ? OR LOWER(league) LIKE ?)'); const l = `%${q.q.toLowerCase()}%`; p.push(l, l, l); }
  const rows = all<MatchRow>(`SELECT * FROM matches WHERE ${where.join(' AND ')}
    ORDER BY (status = 'live') DESC, CASE WHEN status = 'finished' THEN starts_at END DESC, starts_at ASC LIMIT 200`, ...p);
  res.json({ matches: rows.map(matchDto) });
});

publicRouter.get('/matches/:id', (req, res) => {
  const m = get<MatchRow>('SELECT * FROM matches WHERE id = ?', String(req.params.id));
  if (!m) throw notFound('Match not found');
  res.json(matchDto(m));
});

publicRouter.get('/sports', (_req, res) => {
  res.json({ sports: all("SELECT sport AS name, COUNT(*) AS matches, SUM(status = 'live') AS live FROM matches WHERE status IN ('scheduled','live') GROUP BY sport ORDER BY sport") });
});

publicRouter.get('/promotions', (_req, res) => {
  res.json({ promotions: all<any>("SELECT * FROM promotions WHERE active = 1 AND LOWER(title) NOT IN ('aviator cashback','acca boost') ORDER BY sort").map((p) => ({ id: p.id, title: p.title, desc: p.description, reward: p.reward, image: p.image, tag: p.tag })) });
});

publicRouter.get('/games', (_req, res) => {
  res.json({
    games: all<any>('SELECT * FROM games ORDER BY sort').map((g) => ({
      id: g.id, name: g.name, image: g.image, tag: g.tag,
      rtp: g.id === 'roulette' ? '97.3%' : g.id === 'slots' ? '92.6%' : g.rtp,
      playable: !!g.playable || g.id === 'roulette' || g.id === 'slots',
    }))
  });
});
