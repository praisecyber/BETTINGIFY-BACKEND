import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

const eventSchema = z.object({
  idEvent: z.string().nullable().optional(),
  strSport: z.string().nullable().optional(),
  strLeague: z.string().nullable().optional(),
  strHomeTeam: z.string().nullable().optional(),
  strAwayTeam: z.string().nullable().optional(),
  strTimestamp: z.string().nullable().optional(),
  dateEvent: z.string().nullable().optional(),
  strTime: z.string().nullable().optional(),
  strStatus: z.string().nullable().optional(),
  strPostponed: z.string().nullable().optional(),
  intHomeScore: z.union([z.string(), z.number()]).nullable().optional(),
  intAwayScore: z.union([z.string(), z.number()]).nullable().optional(),
  strHomeTeamBadge: z.string().nullable().optional(),
  strAwayTeamBadge: z.string().nullable().optional(),
}).passthrough();
const responseSchema = z.object({
  events: z.array(eventSchema).nullable().optional(),
});

export interface SportsFeedEvent {
  id: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: string;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  score: string | null;
  result: 'home' | 'draw' | 'away' | null;
  homeLogo?: string;
  awayLogo?: string;
}

export function normalizeTeamLogoUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type SportsDay = Awaited<ReturnType<typeof fetchSportsDay>>;
const cache = new Map<string, { expiresAt: number; data: SportsDay }>();
const inFlight = new Map<string, Promise<SportsDay>>();

function eventDto(event: z.infer<typeof eventSchema>): SportsFeedEvent | null {
  if (!event?.idEvent || !event.strHomeTeam || !event.strAwayTeam) return null;
  const startsAtValue = event.strTimestamp || (event.dateEvent
    ? `${event.dateEvent}T${event.strTime || '00:00:00'}Z`
    : null);
  if (!startsAtValue) return null;
  const startsAtRaw = /(?:Z|[+-]\d{2}:\d{2})$/i.test(startsAtValue) ? startsAtValue : `${startsAtValue}Z`;
  if (!Number.isFinite(Date.parse(startsAtRaw))) return null;

  const rawStatus = (event.strStatus ?? '').toUpperCase();
  const postponed = (event.strPostponed ?? '').toLowerCase() === 'yes' || rawStatus.includes('POSTPON');
  const finished = /^(FT|AET|PEN|FINISHED|MATCH FINISHED|FULL TIME)\b/.test(rawStatus);
  const live = /^(LIVE|IN PLAY|HT|HALF ?TIME|HALFTIME|ET|EXTRA TIME|PENALTIES|PENALTY SHOOTOUT|FIRST HALF|SECOND HALF|THIRD HALF|FOURTH HALF|\d+(ST|ND|RD|TH) HALF)\b/.test(rawStatus);
  const startsAt = new Date(startsAtRaw).toISOString();
  const status = postponed ? 'cancelled' : finished ? 'finished' : live ? 'live' : 'scheduled';

  const homeScore = event.intHomeScore;
  const awayScore = event.intAwayScore;
  const hasScore = homeScore !== null && homeScore !== undefined && awayScore !== null && awayScore !== undefined
    && String(homeScore) !== '' && String(awayScore) !== '';
  const score = hasScore ? `${homeScore} - ${awayScore}` : null;
  const result = status !== 'finished' || !hasScore ? null
    : Number(homeScore) > Number(awayScore) ? 'home'
      : Number(homeScore) < Number(awayScore) ? 'away' : 'draw';
  const homeLogo = normalizeTeamLogoUrl(event.strHomeTeamBadge);
  const awayLogo = normalizeTeamLogoUrl(event.strAwayTeamBadge);

  return {
    id: `thesportsdb:${event.idEvent}`,
    sport: event.strSport ?? 'Sport',
    league: event.strLeague ?? 'Competition',
    home: event.strHomeTeam,
    away: event.strAwayTeam,
    startsAt,
    status,
    score,
    result,
    ...(homeLogo ? { homeLogo } : {}),
    ...(awayLogo ? { awayLogo } : {}),
  };
}

async function fetchSportsDay(date: string, sport: string) {
  if (!config.sportsDbApiKey) {
    throw new AppError(503, 'SPORTS_DB_API_KEY_NOT_CONFIGURED', 'TheSportsDB key is not configured on the backend');
  }
  const url = new URL(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(config.sportsDbApiKey)}/eventsday.php`);
  url.searchParams.set('d', date);
  url.searchParams.set('s', sport);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new AppError(502, 'SPORTS_FEED_UNAVAILABLE', 'Sports data provider could not be reached');
  }
  if (!response.ok) throw new AppError(502, 'SPORTS_FEED_ERROR', `Sports data provider returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'SPORTS_FEED_INVALID_RESPONSE', 'Sports data provider returned invalid JSON');
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(502, 'SPORTS_FEED_INVALID_RESPONSE', 'Sports data provider returned an unexpected response');
  return {
    provider: 'TheSportsDB',
    date,
    sport,
    events: (parsed.data.events ?? []).map(eventDto).filter((event): event is SportsFeedEvent => event !== null),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getSportsDay(date: string, sport: string) {
  const key = `${date}:${sport.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchSportsDay(date, sport).then((data) => {
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
