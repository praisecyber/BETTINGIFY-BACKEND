import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type P = string | number | bigint | null | Uint8Array;
const cache = new Map<string, StatementSync>();
const stmt = (sql: string) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};

export const get = <T = any>(sql: string, ...p: P[]) => stmt(sql).get(...p) as T | undefined;
export const all = <T = any>(sql: string, ...p: P[]) => stmt(sql).all(...p) as T[];
export const run = (sql: string, ...p: P[]) => stmt(sql).run(...p);

let depth = 0;
/** Runs fn inside a write transaction (re-entrant). fn MUST be synchronous. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('hex')}`;
export const nowIso = () => new Date().toISOString();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT REFERENCES users(id),
  date_of_birth TEXT,
  email_verified_at TEXT,
  age_verification_status TEXT NOT NULL DEFAULT 'unverified',
  identity_verification_status TEXT NOT NULL DEFAULT 'unverified',
  daily_deposit_limit INTEGER,
  monthly_deposit_limit INTEGER,
  self_excluded_until TEXT,
  self_excluded_permanent INTEGER NOT NULL DEFAULT 0,
  welcome_bonus_claimed INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

-- cash = withdrawable money, bonus = locked promo funds until wagering is met
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cash INTEGER NOT NULL DEFAULT 0 CHECK (cash >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  wager_remaining INTEGER NOT NULL DEFAULT 0 CHECK (wager_remaining >= 0),
  updated_at TEXT NOT NULL
);

-- append-only audit trail of every balance movement
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('cash','bonus')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  min_amount INTEGER NOT NULL,
  max_amount INTEGER NOT NULL,
  eta TEXT NOT NULL,
  icon TEXT NOT NULL,
  can_deposit INTEGER NOT NULL DEFAULT 1,
  can_withdraw INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','withdraw')),
  method TEXT NOT NULL REFERENCES payment_methods(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','rejected','cancelled')),
  provider_ref TEXT,
  destination TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider_ref);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  league TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','finished','cancelled')),
  score TEXT,
  odds_home INTEGER NOT NULL,  -- decimal odds x1000 (2.10 => 2100)
  odds_draw INTEGER NOT NULL DEFAULT 0, -- 0 = no draw market
  odds_away INTEGER NOT NULL,
  result TEXT CHECK (result IN ('home','draw','away'))
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, starts_at);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('sport','aviator')),
  match_id TEXT REFERENCES matches(id),
  match_label TEXT NOT NULL,
  selection TEXT,
  selection_label TEXT NOT NULL,
  odds INTEGER NOT NULL DEFAULT 0,
  stake INTEGER NOT NULL CHECK (stake > 0),
  stake_cash INTEGER NOT NULL,
  stake_bonus INTEGER NOT NULL,
  potential INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','cashed_out','void')),
  payout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id, status);

CREATE TABLE IF NOT EXISTS gift_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gift_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, gift_id, period_key)
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward TEXT NOT NULL,
  image TEXT NOT NULL,
  tag TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  tag TEXT NOT NULL,
  rtp TEXT NOT NULL,
  playable INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jackpot_draws (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL UNIQUE,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','drawn','void')),
  server_seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  entry_ids TEXT,
  selection_counter INTEGER,
  winning_entry_index INTEGER,
  winning_entry_id TEXT,
  winner_user_id TEXT REFERENCES users(id),
  prize INTEGER NOT NULL DEFAULT 0 CHECK (prize >= 0),
  created_at TEXT NOT NULL,
  drawn_at TEXT
);
CREATE TABLE IF NOT EXISTS jackpot_entries (
  id TEXT PRIMARY KEY,
  draw_id TEXT NOT NULL REFERENCES jackpot_draws(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jackpot_entries_draw ON jackpot_entries(draw_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jackpot_entries_user ON jackpot_entries(user_id, draw_id);

CREATE TABLE IF NOT EXISTS casino_rounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  game_id TEXT NOT NULL CHECK (game_id IN ('roulette','slots')),
  stake INTEGER NOT NULL CHECK (stake > 0),
  stake_cash INTEGER NOT NULL,
  stake_bonus INTEGER NOT NULL,
  choice TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casino_rounds_user ON casino_rounds(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aviator_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  crash_x100 INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'betting' CHECK (status IN ('betting','flying','crashed','aborted')),
  created_at TEXT NOT NULL,
  crashed_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS account_verification_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT REFERENCES users(id),
  age_status TEXT NOT NULL,
  identity_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_events_user ON account_verification_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_account_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bet_legs (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL REFERENCES bets(id),
  match_id TEXT NOT NULL REFERENCES matches(id),
  selection TEXT NOT NULL CHECK (selection IN ('home','draw','away')),
  odds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','void')),
  UNIQUE (bet_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_bet_legs_match ON bet_legs(match_id, status);
`);

const userColumns = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
const userMigrations: [string, string][] = [
  ['date_of_birth', 'TEXT'],
  ['email_verified_at', 'TEXT'],
  ['age_verification_status', "TEXT NOT NULL DEFAULT 'unverified'"],
  ['identity_verification_status', "TEXT NOT NULL DEFAULT 'unverified'"],
  ['daily_deposit_limit', 'INTEGER'],
  ['monthly_deposit_limit', 'INTEGER'],
  ['self_excluded_until', 'TEXT'],
  ['self_excluded_permanent', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [column, definition] of userMigrations) {
  if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
