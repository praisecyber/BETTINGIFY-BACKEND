try { process.loadEnvFile(); } catch { /* no .env file, rely on real env */ }

const env = process.env;
const int = (k: string, d: number) => (env[k] ? parseInt(env[k]!, 10) : d);
const isProd = env.NODE_ENV === 'production';
const minGamblingAge = env.MIN_GAMBLING_AGE === undefined ? 18 : Number(env.MIN_GAMBLING_AGE);

if (!Number.isInteger(minGamblingAge) || minGamblingAge < 18 || minGamblingAge > 25) {
  throw new Error('MIN_GAMBLING_AGE must be an integer between 18 and 25');
}

const jackpotTicketCents = int('JACKPOT_TICKET_CENTS', 10_000);
const jackpotMaxEntriesPerUser = int('JACKPOT_MAX_ENTRIES_PER_USER', 10);
if (!Number.isSafeInteger(jackpotTicketCents) || jackpotTicketCents < 100) {
  throw new Error('JACKPOT_TICKET_CENTS must be an integer of at least 100');
}
if (!Number.isInteger(jackpotMaxEntriesPerUser) || jackpotMaxEntriesPerUser < 1 || jackpotMaxEntriesPerUser > 100) {
  throw new Error('JACKPOT_MAX_ENTRIES_PER_USER must be an integer between 1 and 100');
}

if (isProd && (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || !env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 32)) {
  throw new Error('JWT_SECRET and WEBHOOK_SECRET must each be at least 32 characters in production');
}
if (isProd && !env.MIN_GAMBLING_AGE) {
  throw new Error('MIN_GAMBLING_AGE must be set for the licensed market in production');
}
const adminPassword = env.ADMIN_PASSWORD;
const complexAdminPassword = adminPassword
  && adminPassword.length >= 12
  && /[a-z]/.test(adminPassword)
  && /[A-Z]/.test(adminPassword)
  && /[0-9]/.test(adminPassword)
  && /[^A-Za-z0-9]/.test(adminPassword);
const generatedAdminPassword = adminPassword && /^[A-Fa-f0-9]{64,}$/.test(adminPassword);
if (isProd && adminPassword && !complexAdminPassword && !generatedAdminPassword) {
  throw new Error('ADMIN_PASSWORD must be a strong mixed-complexity password or at least 64 hexadecimal characters');
}

export const config = {
  isProd,
  demoData: env.DEMO_DATA === 'true',
  port: int('PORT', 4000),
  dbPath: env.DB_PATH ?? './data/bettingify.db',
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
  webhookSecret: env.WEBHOOK_SECRET ?? 'dev-only-webhook-secret',
  accessTtlSec: int('ACCESS_TTL_SEC', 15 * 60),
  refreshTtlDays: int('REFRESH_TTL_DAYS', 30),
  bcryptCost: int('BCRYPT_COST', 12),
  minGamblingAge,
  adminEmail: env.ADMIN_EMAIL,
  adminPassword: env.ADMIN_PASSWORD,
  sportsDbApiKey: env.THESPORTSDB_API_KEY?.trim() || undefined,
  sportApiKey: env.SPORTAPI_API_KEY?.trim() || undefined,
  oddsApiKey: env.ODDS_API_KEY?.trim() || undefined,
  jackpotEnabled: env.JACKPOT_ENABLED === 'true',
  jackpotTicketCents,
  jackpotMaxEntriesPerUser,

  // money (all in minor units / cents)
  registerBonusCents: int('REGISTER_BONUS_CENTS', 500),
  welcomeBonusMaxCents: int('WELCOME_BONUS_MAX_CENTS', 50_000),
  bonusWagerMultiplier: int('BONUS_WAGER_MULT', 3),
  minStakeCents: int('MIN_STAKE_CENTS', 100),
  maxStakeCents: int('MAX_STAKE_CENTS', 1_000_000),
  cashoutMarginPct: int('CASHOUT_MARGIN_PCT', 92),

  aviator: {
    bettingMs: int('AVIATOR_BETTING_MS', 6000),
    crashPauseMs: int('AVIATOR_CRASH_PAUSE_MS', 3500),
    tickMs: int('AVIATOR_TICK_MS', 100),
    minBetCents: int('AVIATOR_MIN_BET_CENTS', 100),
    maxBetCents: int('AVIATOR_MAX_BET_CENTS', 100_000),
    maxMultiplierX100: 100_000, // 1000x hard cap
  },
};
