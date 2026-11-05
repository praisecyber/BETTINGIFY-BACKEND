import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { normalizeTeamLogoUrl, type SportsFeedEvent } from './sportsFeed.js';

const fixtureSchema = z.object({
  id: z.union([z.string(), z.number()]),
  home_id: z.union([z.string(), z.number()]).nullable().optional(),
  away_id: z.union([z.string(), z.number()]).nullable().optional(),
  date: z.string().optional(),
  datetime: z.string().nullable().optional(),
  kickoff_utc: z.string().nullable().optional(),
  home_score: z.union([z.string(), z.number()]).nullable().optional(),
  away_score: z.union([z.string(), z.number()]).nullable().optional(),
  status: z.string().nullable().optional(),
  league_name: z.string().nullable().optional(),
  home_team: z.string().nullable().optional(),
  away_team: z.string().nullable().optional(),
  home_logo: z.string().nullable().optional(),
  away_logo: z.string().nullable().optional(),
  winner: z.string().nullable().optional(),
}).passthrough();

const responseSchema = z.object({
  success: z.literal(true),
  date: z.string().optional(),
  data: z.array(fixtureSchema).optional(),
});

const basketballTeamSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  name: z.string(),
  logo_url: z.string().nullable().optional(),
  score: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();
const basketballGameSchema = z.object({
  id: z.union([z.string(), z.number()]),
  start: z.string(),
  status: z.string(),
  live: z.boolean().optional(),
  league: z.object({ name: z.string() }).passthrough(),
  home: basketballTeamSchema,
  away: basketballTeamSchema,
}).passthrough();
const basketballResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(basketballGameSchema).optional(),
});

type SportApiDay = Awaited<ReturnType<typeof fetchSportApiDay>>;
const cache = new Map<string, { expiresAt: number; data: SportApiDay }>();
const inFlight = new Map<string, Promise<SportApiDay>>();
const feedCacheMs = 120_000;

function fixtureDto(fixture: z.infer<typeof fixtureSchema>): SportsFeedEvent | null {
  if (!fixture.home_team || !fixture.away_team) return null;
  const startsAtValue = fixture.kickoff_utc || fixture.datetime || (fixture.date ? `${fixture.date}T00:00:00Z` : null);
  if (!startsAtValue) return null;
  const normalizedDateTime = startsAtValue.includes('T') ? startsAtValue : startsAtValue.replace(' ', 'T');
  const startsAtRaw = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalizedDateTime)
    ? normalizedDateTime
    : `${normalizedDateTime}Z`;
  if (!Number.isFinite(Date.parse(startsAtRaw))) return null;

  const rawStatus = (fixture.status ?? '').trim().toUpperCase();
  const postponed = /POSTPON|CANCEL|ABANDON/.test(rawStatus);
  const finished = /^(FT|AET|PEN|FINISHED|FULL TIME)\b/.test(rawStatus);
  const live = /^(LIVE|IN PLAY|HT|HALF ?TIME|HALFTIME|ET|EXTRA TIME|PENALTIES|\d+(ST|ND|RD|TH) HALF)\b/.test(rawStatus);
  const status = postponed ? 'cancelled' : finished ? 'finished' : live ? 'live' : 'scheduled';
  const hasScore = fixture.home_score !== null && fixture.home_score !== undefined
    && fixture.away_score !== null && fixture.away_score !== undefined;
  const score = hasScore ? `${fixture.home_score} - ${fixture.away_score}` : null;
  const winner = (fixture.winner ?? '').toLowerCase();
  const result = status !== 'finished' ? null
    : winner === 'home' || winner === 'away' || winner === 'draw' ? winner
      : hasScore && Number(fixture.home_score) > Number(fixture.away_score) ? 'home'
        : hasScore && Number(fixture.home_score) < Number(fixture.away_score) ? 'away'
          : hasScore ? 'draw' : null;
  const logoPath = (teamId: string | number | null | undefined) => {
    const id = Number(teamId);
    return Number.isSafeInteger(id) && id > 0 ? `/sports-feed/sportapi/teams/${id}/logo` : undefined;
  };
  const homeLogo = logoPath(fixture.home_id);
  const awayLogo = logoPath(fixture.away_id);

  return {
    id: `sportapi:${fixture.id}`,
    sport: 'Football',
    league: fixture.league_name ?? 'Competition',
    home: fixture.home_team,
    away: fixture.away_team,
    startsAt: new Date(startsAtRaw).toISOString(),
    status,
    score,
    result,
    ...(homeLogo ? { homeLogo } : {}),
    ...(awayLogo ? { awayLogo } : {}),
  };
}

async function fetchSportApiFootballDay(date: string, apiKey = config.sportApiKey) {
  if (!apiKey) {
    throw new AppError(503, 'SPORTAPI_KEY_NOT_CONFIGURED', 'SportAPI key is not configured on the backend');
  }
  let response: Response;
  try {
    response = await fetch(`https://sportapi.ai/api/fixtures/date/${date}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError(502, 'SPORTAPI_UNAVAILABLE', 'SportAPI could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'SPORTAPI_ERROR', `SportAPI returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'SPORTAPI_INVALID_RESPONSE', 'SportAPI returned invalid JSON');
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(502, 'SPORTAPI_INVALID_RESPONSE', 'SportAPI returned an unexpected response');
  return (parsed.data.data ?? []).map(fixtureDto).filter((event): event is SportsFeedEvent => event !== null);
}

function basketballGameDto(game: z.infer<typeof basketballGameSchema>): SportsFeedEvent | null {
  const startsAt = new Date(game.start);
  if (!Number.isFinite(startsAt.getTime())) return null;

  const rawStatus = game.status.trim().toUpperCase();
  const cancelled = /^(POST|POSTPONED|CANC|CANCELLED)$/.test(rawStatus);
  const finished = /^(FT|AOT|FINISHED)$/.test(rawStatus);
  const live = game.live === true || /^(Q[1-4]|H[1-2]|HT|OT|LIVE)$/.test(rawStatus);
  const status = cancelled ? 'cancelled' : finished ? 'finished' : live ? 'live' : 'scheduled';
  const hasScore = game.home.score !== null && game.home.score !== undefined
    && game.away.score !== null && game.away.score !== undefined;
  const score = hasScore ? `${game.home.score} - ${game.away.score}` : null;
  const result = status !== 'finished' || !hasScore ? null
    : Number(game.home.score) > Number(game.away.score) ? 'home'
      : Number(game.home.score) < Number(game.away.score) ? 'away' : 'draw';
  const homeLogo = normalizeTeamLogoUrl(game.home.logo_url);
  const awayLogo = normalizeTeamLogoUrl(game.away.logo_url);

  return {
    id: `sportapi:basketball:${game.id}`,
    sport: 'Basketball',
    league: game.league.name,
    home: game.home.name,
    away: game.away.name,
    startsAt: startsAt.toISOString(),
    status,
    score,
    result,
    ...(homeLogo ? { homeLogo } : {}),
    ...(awayLogo ? { awayLogo } : {}),
  };
}

async function fetchSportApiBasketballDay(date: string, apiKey = config.sportApiKey) {
  if (!apiKey) {
    throw new AppError(503, 'SPORTAPI_KEY_NOT_CONFIGURED', 'SportAPI key is not configured on the backend');
  }
  let response: Response;
  try {
    response = await fetch(`https://sportapi.ai/api/basketball/games/date/${date}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError(502, 'SPORTAPI_UNAVAILABLE', 'SportAPI basketball data could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'SPORTAPI_ERROR', `SportAPI basketball endpoint returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'SPORTAPI_INVALID_RESPONSE', 'SportAPI basketball endpoint returned invalid JSON');
  }
  const parsed = basketballResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(502, 'SPORTAPI_INVALID_RESPONSE', 'SportAPI basketball endpoint returned an unexpected response');
  return (parsed.data.data ?? []).map(basketballGameDto).filter((event): event is SportsFeedEvent => event !== null);
}

async function fetchSportApiDay(date: string, apiKey = config.sportApiKey) {
  const [football, basketball] = await Promise.all([
    fetchSportApiFootballDay(date, apiKey),
    fetchSportApiBasketballDay(date, apiKey),
  ]);
  return {
    provider: 'SportAPI',
    date,
    events: [...football, ...basketball],
    fetchedAt: new Date().toISOString(),
  };
}

export async function getSportApiDay(date: string, apiKey = config.sportApiKey) {
  const cached = cache.get(date);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = inFlight.get(date);
  if (pending) return pending;
  const request = fetchSportApiDay(date, apiKey).then((data) => {
    cache.set(date, { expiresAt: Date.now() + feedCacheMs, data });
    if (cache.size > 100) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return data;
  }).finally(() => inFlight.delete(date));
  inFlight.set(date, request);
  return request;
}

interface TeamLogo { contentType: string; body: Buffer }
const teamLogoCache = new Map<number, { expiresAt: number; data: TeamLogo }>();
const teamLogoInFlight = new Map<number, Promise<TeamLogo>>();

async function fetchSportApiTeamLogo(teamId: number, apiKey = config.sportApiKey): Promise<TeamLogo> {
  if (!apiKey) throw new AppError(503, 'SPORTAPI_KEY_NOT_CONFIGURED', 'SportAPI key is not configured on the backend');
  let response: Response;
  try {
    response = await fetch(`https://sportapi.ai/api/teams/${teamId}/logo`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError(502, 'SPORTAPI_UNAVAILABLE', 'SportAPI logo could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'SPORTAPI_LOGO_ERROR', `SportAPI logo endpoint returned HTTP ${response.status}`);

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'].includes(contentType))
    throw new AppError(502, 'SPORTAPI_LOGO_INVALID', 'SportAPI returned an unsupported team logo format');
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > 2_000_000) throw new AppError(502, 'SPORTAPI_LOGO_TOO_LARGE', 'SportAPI team logo exceeds the size limit');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > 2_000_000) throw new AppError(502, 'SPORTAPI_LOGO_TOO_LARGE', 'SportAPI team logo exceeds the size limit');
  return { contentType, body };
}

export async function getSportApiTeamLogo(teamId: number, apiKey = config.sportApiKey) {
  const cached = teamLogoCache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = teamLogoInFlight.get(teamId);
  if (pending) return pending;
  const request = fetchSportApiTeamLogo(teamId, apiKey).then((data) => {
    teamLogoCache.set(teamId, { expiresAt: Date.now() + 86_400_000, data });
    if (teamLogoCache.size > 300) {
      const oldest = teamLogoCache.keys().next().value;
      if (oldest !== undefined) teamLogoCache.delete(oldest);
    }
    return data;
  }).finally(() => teamLogoInFlight.delete(teamId));
  teamLogoInFlight.set(teamId, request);
  return request;
}
