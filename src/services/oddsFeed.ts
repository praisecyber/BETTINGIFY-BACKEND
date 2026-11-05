import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

const outcomeSchema = z.object({
  name: z.string(),
  price: z.number().finite().positive(),
  point: z.number().finite().nullable().optional(),
  description: z.string().nullable().optional(),
});
const marketSchema = z.object({
  key: z.string(),
  last_update: z.string().nullable().optional(),
  outcomes: z.array(outcomeSchema),
});
const bookmakerSchema = z.object({
  key: z.string(),
  title: z.string(),
  last_update: z.string().nullable().optional(),
  markets: z.array(marketSchema),
});
const eventSchema = z.object({
  id: z.string(),
  sport_key: z.string(),
  sport_title: z.string(),
  commence_time: z.string().datetime({ offset: true }),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z.array(bookmakerSchema).optional(),
});
const responseSchema = z.array(eventSchema);
const sportSchema = z.object({
  key: z.string(),
  group: z.string(),
  title: z.string(),
  description: z.string(),
  active: z.boolean(),
  has_outrights: z.boolean(),
});
const sportsResponseSchema = z.array(sportSchema);

export interface OddsSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  hasOutrights: boolean;
}

export interface OddsFeedEvent {
  id: string;
  sportKey: string;
  sport: string;
  startsAt: string;
  home: string;
  away: string;
  bookmakers: {
    key: string;
    name: string;
    updatedAt: string | null;
    markets: {
      key: string;
      updatedAt: string | null;
      outcomes: { name: string; price: number; point: number | null; description: string | null }[];
    }[];
  }[];
}

type OddsDay = Awaited<ReturnType<typeof fetchOdds>>;
const cache = new Map<string, { expiresAt: number; data: OddsDay }>();
const inFlight = new Map<string, Promise<OddsDay>>();
let sportsCache: { expiresAt: number; data: OddsSport[] } | null = null;
let sportsInFlight: Promise<OddsSport[]> | null = null;

async function fetchOddsSports(apiKey = config.oddsApiKey): Promise<OddsSport[]> {
  if (!apiKey) throw new AppError(503, 'ODDS_API_KEY_NOT_CONFIGURED', 'The Odds API key is not configured on the backend');
  const url = new URL('https://api.the-odds-api.com/v4/sports/');
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('all', 'false');
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new AppError(502, 'ODDS_API_UNAVAILABLE', 'The Odds API could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'ODDS_API_ERROR', `The Odds API returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'ODDS_API_INVALID_RESPONSE', 'The Odds API returned invalid JSON');
  }
  const parsed = sportsResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(502, 'ODDS_API_INVALID_RESPONSE', 'The Odds API returned an unexpected sports list');
  return parsed.data.filter((sport) => sport.active).map((sport) => ({
    key: sport.key,
    group: sport.group,
    title: sport.title,
    description: sport.description,
    active: sport.active,
    hasOutrights: sport.has_outrights,
  }));
}

export async function getOddsSports(apiKey = config.oddsApiKey) {
  if (sportsCache && sportsCache.expiresAt > Date.now()) return sportsCache.data;
  if (sportsInFlight) return sportsInFlight;
  const request = fetchOddsSports(apiKey).then((data) => {
    sportsCache = { expiresAt: Date.now() + 15 * 60_000, data };
    return data;
  }).finally(() => { sportsInFlight = null; });
  sportsInFlight = request;
  return request;
}

async function fetchOdds(sportKey: string, regions: string, markets: string, apiKey = config.oddsApiKey) {
  if (!apiKey) throw new AppError(503, 'ODDS_API_KEY_NOT_CONFIGURED', 'The Odds API key is not configured on the backend');
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds/`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', regions);
  url.searchParams.set('markets', markets);
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new AppError(502, 'ODDS_API_UNAVAILABLE', 'The Odds API could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'ODDS_API_ERROR', `The Odds API returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'ODDS_API_INVALID_RESPONSE', 'The Odds API returned invalid JSON');
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(502, 'ODDS_API_INVALID_RESPONSE', 'The Odds API returned an unexpected response');
  return {
    provider: 'The Odds API',
    sportKey,
    regions: regions.split(','),
    markets: markets.split(','),
    events: parsed.data.map((event): OddsFeedEvent => ({
      id: event.id,
      sportKey: event.sport_key,
      sport: event.sport_title,
      startsAt: new Date(event.commence_time).toISOString(),
      home: event.home_team,
      away: event.away_team,
      bookmakers: (event.bookmakers ?? []).map((bookmaker) => ({
        key: bookmaker.key,
        name: bookmaker.title,
        updatedAt: bookmaker.last_update ?? null,
        markets: bookmaker.markets.map((market) => ({
          key: market.key,
          updatedAt: market.last_update ?? null,
          outcomes: market.outcomes.map((outcome) => ({
            name: outcome.name,
            price: outcome.price,
            point: outcome.point ?? null,
            description: outcome.description ?? null,
          })),
        })),
      })),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getOdds(sportKey: string, regions: string, markets: string, apiKey = config.oddsApiKey) {
  const key = `${sportKey}:${regions}:${markets}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchOdds(sportKey, regions, markets, apiKey).then((data) => {
    cache.set(key, { expiresAt: Date.now() + 60_000, data });
    if (cache.size > 100) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return data;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
