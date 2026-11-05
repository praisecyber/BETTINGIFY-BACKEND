process.env.DB_PATH = ':memory:';
process.env.BCRYPT_COST = '4';
process.env.ADMIN_EMAIL = 'admin@test.io';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.AVIATOR_BETTING_MS = '300';
process.env.AVIATOR_CRASH_PAUSE_MS = '200';
process.env.AVIATOR_TICK_MS = '20';
process.env.JACKPOT_ENABLED = 'true';
process.env.DEMO_DATA = 'true';
process.env.THESPORTSDB_API_KEY = 'test-sports-db-key';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { Server } from 'node:http';

let base = ''; let server: Server;
let aviator: typeof import('../src/services/aviator.js');

before(async () => {
  const { seedReferenceData } = await import('../src/seed.js');
  const { createApp } = await import('../src/app.js');
  aviator = await import('../src/services/aviator.js');
  await seedReferenceData();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
});
after(() => { aviator.aviator.stop(); server.close(); });

async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const reg = (email: string, phone: string, extra = {}) => api('POST', '/auth/register', {
  email, phone, password: 'secret1234', firstName: 'Ada', lastName: 'Obi', dateOfBirth: '1990-01-01', acceptedTerms: true, ...extra,
});
async function makeEligible(token: string, admin: string) {
  const mail = await api('POST', '/auth/email/resend', {}, token);
  assert.equal(mail.status, 200);
  assert.equal((await api('POST', '/auth/email/verify', { token: mail.body.developmentToken })).status, 200);
  await api('POST', '/me/verification', {}, token);
  const me = await api('GET', '/me', undefined, token);
  const review = await api('PATCH', `/admin/users/${me.body.id}/verification`, {
    age: 'verified', identity: 'verified', note: 'Reviewed age and identity documents',
  }, admin);
  assert.equal(review.status, 200);
}

test('register, login, validation', async () => {
  const bad = await api('POST', '/auth/register', { email: 'x', password: '1' });
  assert.equal(bad.status, 400);
  const underage = await reg('minor@test.io', '+2348000000099', { dateOfBirth: '2012-01-01' });
  assert.equal(underage.body.error.code, 'MINIMUM_AGE_NOT_MET');
  const r = await reg('ada@test.io', '+234 801 234 5678');
  assert.equal(r.status, 201);
  assert.equal(r.body.user.phone, '+2348012345678');
  assert.equal((await reg('ada@test.io', '+2348000000001')).status, 409);
  const l = await api('POST', '/auth/login', { identifier: 'ada@test.io', password: 'secret1234' });
  assert.equal(l.status, 200);
  assert.equal((await api('POST', '/auth/login', { identifier: 'ada@test.io', password: 'nope' })).status, 401);
  const promotions = await api('GET', '/promotions');
  assert.equal(promotions.status, 200);
  assert.ok(promotions.body.promotions.every((promotion: { title: string }) => !['Aviator Cashback', 'Acca Boost'].includes(promotion.title)));
  const me = await api('GET', '/me', undefined, l.body.accessToken);
  assert.equal(me.body.wallet.currency, 'NGN');
  assert.equal(me.body.wallet.bonus, 5);
  assert.equal(me.body.wallet.withdrawable, 0);
  const rf = await api('POST', '/auth/refresh', { refreshToken: l.body.refreshToken });
  assert.equal(rf.status, 200);
  assert.equal((await api('POST', '/auth/refresh', { refreshToken: l.body.refreshToken })).status, 401); // rotated
  assert.equal((await api('GET', '/me')).status, 401);
});

test('TheSportsDB feed is proxied server-side and never becomes a betting market', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://www.thesportsdb.com/')) {
      upstreamRequests++;
      assert.match(url, /eventsday\.php\?d=2026-11-03&s=Soccer/);
      return new Response(JSON.stringify({
        events: [{
          idEvent: '12345', strSport: 'Soccer', strLeague: 'Test League',
          strHomeTeam: 'Home FC', strAwayTeam: 'Away FC', strTimestamp: '2026-11-03T18:00:00',
          strStatus: 'FT', intHomeScore: '2', intAwayScore: '1',
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const feed = await api('GET', '/sports-feed/events?date=2026-11-03&sport=Soccer');
    assert.equal(feed.status, 200);
    assert.equal(upstreamRequests, 1);
    assert.deepEqual(feed.body.events[0], {
      id: 'thesportsdb:12345', sport: 'Soccer', league: 'Test League', home: 'Home FC', away: 'Away FC',
      startsAt: '2026-11-03T18:00:00.000Z', status: 'finished', score: '2 - 1', result: 'home',
    });
    assert.equal('odds' in feed.body.events[0], false);
    const cachedFeed = await api('GET', '/sports-feed/events?date=2026-11-03&sport=Soccer');
    assert.equal(cachedFeed.status, 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deposit with welcome bonus, bet, settle, withdraw', async () => {
  const u = (await reg('bob@test.io', '+2348000000002')).body;
  const t = u.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  assert.equal((await api('POST', '/wallet/deposit', { method: 'visa', amount: 100 }, t)).body.error.code, 'EMAIL_NOT_VERIFIED');
  await makeEligible(t, admin);
  await api('PATCH', '/me/deposit-limits', { daily: 150, monthly: 200 }, t);

  const key = { 'Idempotency-Key': 'dep-1' };
  const d = await api('POST', '/wallet/deposit', { method: 'visa', amount: 100, claimWelcomeBonus: true }, t, key);
  assert.equal(d.status, 201);
  const d2 = await api('POST', '/wallet/deposit', { method: 'visa', amount: 100, claimWelcomeBonus: true }, t, key);
  assert.equal(d2.body.payment.id, d.body.payment.id); // replayed, not charged twice
  assert.equal((await api('POST', '/wallet/deposit', { method: 'visa', amount: 60 }, t)).body.error.code, 'DEPOSIT_LIMIT_REACHED');
  let w = (await api('GET', '/wallet', undefined, t)).body;
  assert.equal(w.withdrawable, 100);
  assert.equal(w.bonus, 105); // ₦5 signup + ₦100 welcome match
  assert.equal((await api('POST', '/wallet/deposit', { method: 'visa', amount: 5 }, t)).status, 400); // below min

  const bet = await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 50, expectedOdds: 1.95 }, t);
  assert.equal(bet.status, 201);
  assert.equal(bet.body.bet.potential, 97.5);
  assert.equal((await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 10, expectedOdds: 1.5 }, t)).body.error.code, 'ODDS_CHANGED');
  assert.equal((await api('POST', '/bets', { matchId: 'm4', selection: 'draw', stake: 10 }, t)).body.error.code, 'NO_MARKET');
  assert.equal((await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 99999 }, t)).status, 400);
  assert.equal((await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 5000 }, t)).body.error.code, 'INSUFFICIENT_FUNDS');

  const liveCreated = await api('POST', '/admin/matches', {
    sport: 'Football', league: 'Nigeria Premier League', home: 'Live Home', away: 'Live Away',
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    odds: { home: 2, draw: 3, away: 4 },
  }, admin);
  const liveMatch = liveCreated.body.id;
  assert.equal(liveCreated.status, 201);
  await api('PATCH', `/admin/matches/${liveMatch}`, { status: 'live', score: '1 - 0' }, admin);
  const liveMarkets = await api('GET', '/matches?status=live');
  assert.ok(liveMarkets.body.matches.some((match: any) => match.id === liveMatch && match.isLive));
  const liveBet = await api('POST', '/bets', { matchId: liveMatch, selection: 'home', stake: 1, expectedOdds: 2 }, t);
  assert.equal(liveBet.status, 201);

  assert.equal((await api('POST', '/admin/matches/m2/settle', { result: 'home' }, t)).status, 403);
  const s = await api('POST', '/admin/matches/m2/settle', { result: 'home', score: '2 - 1' }, admin);
  assert.deepEqual([s.body.won, s.body.lost], [1, 0]);
  const results = await api('GET', '/matches?status=finished');
  assert.equal(results.body.matches.find((match: any) => match.id === 'm2').result, 'home');
  assert.equal((await api('POST', '/admin/matches/m2/settle', { result: 'home' }, admin)).status, 409);
  w = (await api('GET', '/wallet', undefined, t)).body;
  assert.equal(w.withdrawable, 100 - 50 - 1 + 97.5);

  // can only withdraw cash, not locked bonus
  assert.equal((await api('POST', '/wallet/withdraw', { method: 'bank', amount: 500 }, t)).status, 400);
  const wd = await api('POST', '/wallet/withdraw', { method: 'bank', amount: 60, destination: '0123456789' }, t);
  assert.equal(wd.status, 202);
  assert.equal((await api('GET', '/wallet', undefined, t)).body.withdrawable, 86.5);
  const rej = await api('POST', `/admin/withdrawals/${wd.body.payment.id}/reject`, { reason: 'KYC needed' }, admin);
  assert.equal(rej.body.payment.status, 'rejected');
  assert.equal((await api('GET', '/wallet', undefined, t)).body.withdrawable, 146.5); // refunded
  const wd2 = await api('POST', '/wallet/withdraw', { method: 'bank', amount: 60 }, t);
  const ok = await api('POST', `/admin/withdrawals/${wd2.body.payment.id}/approve`, {}, admin);
  assert.equal(ok.body.payment.status, 'completed');
  assert.equal((await api('POST', `/admin/withdrawals/${wd2.body.payment.id}/approve`, {}, admin)).status, 409);

  const tx = await api('GET', '/wallet/transactions', undefined, t);
  assert.ok(tx.body.transactions.some((x: any) => x.type === 'withdraw' && x.status === 'completed'));
  const stats = await api('GET', '/admin/stats', undefined, admin);
  assert.equal(stats.status, 200);
});

test('cash out, void match, gifts, pending deposit webhook', async () => {
  const t = (await reg('cy@test.io', '+2348000000003')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  await makeEligible(t, admin);
  await api('POST', '/wallet/deposit', { method: 'visa', amount: 200 }, t);
  const b = await api('POST', '/bets', { matchId: 'm5', selection: 'home', stake: 20 }, t);
  const offer = b.body.bet.cashoutOffer;
  assert.ok(offer > 0 && offer < b.body.bet.potential);
  const co = await api('POST', `/bets/${b.body.bet.id}/cashout`, { expectedValue: offer }, t);
  assert.equal(co.body.bet.status, 'cashed_out');
  assert.equal((await api('POST', `/bets/${b.body.bet.id}/cashout`, {}, t)).status, 409);

  const b2 = await api('POST', '/bets', { matchId: 'm6', selection: 'away', stake: 10 }, t);
  const before = (await api('GET', '/wallet', undefined, t)).body.balance;
  await api('POST', '/admin/matches/m6/cancel', {}, admin);
  assert.equal((await api('GET', '/wallet', undefined, t)).body.balance, before + 10);
  assert.equal((await api('GET', `/bets/${b2.body.bet.id}`, undefined, t)).body.status, 'void');

  const g = await api('POST', '/gifts/daily/claim', {}, t);
  assert.equal(g.body.bonusAdded, 5);
  assert.equal((await api('POST', '/gifts/daily/claim', {}, t)).status, 409);

  const pd = await api('POST', '/wallet/deposit', { method: 'crypto', amount: 50 }, t);
  assert.equal(pd.body.payment.status, 'pending');
  const { getPayment } = await import('../src/services/payments.js');
  const ref = getPayment(pd.body.payment.id)!.provider_ref!;
  const raw = JSON.stringify({ providerRef: ref, status: 'completed' });
  const hook = (sig: string) => fetch(base + '/webhooks/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw });
  assert.equal((await hook('bad')).status, 401);
  const sig = createHmac('sha256', 'dev-only-webhook-secret').update(raw).digest('hex');
  const cash0 = (await api('GET', '/wallet', undefined, t)).body.withdrawable;
  assert.equal((await hook(sig)).status, 200);
  assert.equal((await hook(sig)).status, 200); // replay is harmless
  assert.equal((await api('GET', '/wallet', undefined, t)).body.withdrawable, cash0 + 50);
});

test('accumulators settle across all legs and refund when a leg is cancelled', async () => {
  const t = (await reg('accumulator@test.io', '+2348000000008')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  await makeEligible(t, admin);
  await api('POST', '/wallet/deposit', { method: 'visa', amount: 100 }, t);
  const createMatch = async (home: string, away: string) => {
    const r = await api('POST', '/admin/matches', {
      sport: 'Football', league: 'Test League', home, away,
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      odds: { home: 2, draw: 3.2, away: 2.5 },
    }, admin);
    assert.equal(r.status, 201);
    return r.body.id as string;
  };
  const first = await createMatch('Alpha', 'Beta');
  const second = await createMatch('Gamma', 'Delta');
  const acca = await api('POST', '/bets/accumulator', {
    legs: [
      { matchId: first, selection: 'home', expectedOdds: 2 },
      { matchId: second, selection: 'away', expectedOdds: 2.5 },
    ],
    stake: 10,
  }, t);
  assert.equal(acca.status, 201);
  assert.equal(acca.body.bet.odds, 5);
  assert.equal(acca.body.bet.potential, 50);
  assert.equal(acca.body.bet.legs.length, 2);
  assert.equal(acca.body.bet.cashoutOffer, null);
  assert.equal((await api('POST', '/bets/accumulator', {
    legs: [
      { matchId: first, selection: 'home' }, { matchId: first, selection: 'away' },
    ], stake: 10
  }, t)).body.error.code, 'DUPLICATE_MATCH');

  assert.equal((await api('POST', `/admin/matches/${first}/settle`, { result: 'home' }, admin)).status, 200);
  let bet = (await api('GET', `/bets/${acca.body.bet.id}`, undefined, t)).body;
  assert.equal(bet.status, 'open');
  assert.deepEqual(bet.legs.map((leg: any) => leg.status), ['won', 'open']);
  assert.equal((await api('POST', `/admin/matches/${second}/settle`, { result: 'away' }, admin)).status, 200);
  bet = (await api('GET', `/bets/${acca.body.bet.id}`, undefined, t)).body;
  assert.equal(bet.status, 'won');
  assert.equal(bet.payout, 50);

  const cancelLeg = await createMatch('Epsilon', 'Zeta');
  const remainingLeg = await createMatch('Eta', 'Theta');
  const refundable = await api('POST', '/bets/accumulator', {
    legs: [{ matchId: cancelLeg, selection: 'home' }, { matchId: remainingLeg, selection: 'away' }], stake: 5,
  }, t);
  assert.equal(refundable.status, 201);
  await api('POST', `/admin/matches/${cancelLeg}/cancel`, {}, admin);
  const voided = (await api('GET', `/bets/${refundable.body.bet.id}`, undefined, t)).body;
  assert.equal(voided.status, 'void');
  assert.equal(voided.payout, 5);
});

test('email reset, identity gates, and self-exclusion block gambling but allow withdrawals', async () => {
  const t = (await reg('safety@test.io', '+2348000000009')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  const user = (await api('GET', '/me', undefined, t)).body;
  assert.equal(user.emailVerified, false);
  assert.equal(user.ageVerificationStatus, 'unverified');
  assert.equal((await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 10 }, t)).body.error.code, 'EMAIL_NOT_VERIFIED');
  await makeEligible(t, admin);
  await api('POST', '/wallet/deposit', { method: 'visa', amount: 100 }, t);
  await api('POST', '/me/self-exclude', { duration: '24h' }, t);
  const firstExclusion = (await api('GET', '/me', undefined, t)).body.selfExcludedUntil;
  await api('POST', '/me/self-exclude', { duration: '7d' }, t);
  const extendedExclusion = (await api('GET', '/me', undefined, t)).body.selfExcludedUntil;
  await api('POST', '/me/self-exclude', { duration: '24h' }, t);
  assert.ok(Date.parse(extendedExclusion) > Date.parse(firstExclusion));
  assert.equal((await api('GET', '/me', undefined, t)).body.selfExcludedUntil, extendedExclusion);
  assert.equal((await api('POST', '/bets', { matchId: 'm2', selection: 'home', stake: 10 }, t)).body.error.code, 'SELF_EXCLUDED');
  assert.equal((await api('POST', '/wallet/deposit', { method: 'visa', amount: 50 }, t)).body.error.code, 'SELF_EXCLUDED');
  assert.equal((await api('POST', '/gifts/daily/claim', {}, t)).body.error.code, 'SELF_EXCLUDED');
  assert.equal((await api('POST', '/wallet/withdraw', { method: 'bank', amount: 50 }, t)).status, 202);

  const reset = await api('POST', '/auth/password/forgot', { email: 'safety@test.io' });
  assert.equal(reset.status, 200);
  assert.equal((await api('POST', '/auth/password/reset', { token: reset.body.developmentToken, newPassword: 'newsecret123' })).status, 204);
  assert.equal((await api('POST', '/auth/login', { identifier: 'safety@test.io', password: 'newsecret123' })).status, 200);
  assert.equal((await api('POST', '/auth/login', { identifier: 'safety@test.io', password: 'secret1234' })).status, 401);
});

test('provably fair crash + aviator round', async () => {
  const { crashFromSeed, seedHash, aviator: eng } = aviator;
  // distribution sanity: RTP of "cash out at 2x" should be ~97%
  let wins = 0; const N = 40000;
  for (let i = 0; i < N; i++) if (crashFromSeed(`seed${i}`, i) >= 200) wins++;
  const rtp = (wins / N) * 2;
  assert.ok(rtp > 0.93 && rtp < 1.01, `rtp ${rtp}`);

  const t = (await reg('dee@test.io', '+2348000000004')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  await makeEligible(t, admin);
  await api('POST', '/wallet/deposit', { method: 'visa', amount: 100 }, t);
  eng.start();
  // wait for a betting phase
  for (let i = 0; i < 100 && eng.phase !== 'betting'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(eng.phase, 'betting');
  const hash = eng.hash;
  const placed = await api('POST', '/aviator/bet', { amount: 10 }, t);
  assert.equal(placed.status, 201);
  assert.equal((await api('POST', '/aviator/bet', { amount: 10 }, t)).body.error.code, 'ALREADY_BET');
  const roundId = placed.body.roundId;
  // wait for the crash
  for (let i = 0; i < 1000 && !(eng.roundId === roundId && eng.phase === 'crashed'); i++) await new Promise((r) => setTimeout(r, 25));
  const v = (await api('GET', `/aviator/rounds/${roundId}`)).body;
  assert.equal(v.revealed, true);
  assert.equal(seedHash(v.serverSeed), hash);
  assert.equal(crashFromSeed(v.serverSeed, roundId) / 100, v.crashPoint);
  const bets = (await api('GET', '/bets?status=settled', undefined, t)).body.bets;
  assert.equal(bets[0].kind, 'aviator');
  assert.ok(['lost', 'won'].includes(bets[0].status));
});

test('roulette and slots use server outcomes, wallet accounting, and idempotent plays', async () => {
  const t = (await reg('casino@test.io', '+2348000000010')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  assert.equal((await api('POST', '/casino/play', { gameId: 'slots', stake: 1 }, t)).body.error.code, 'EMAIL_NOT_VERIFIED');
  await makeEligible(t, admin);

  const beforeRoulette = (await api('GET', '/wallet', undefined, t)).body.balance;
  const roulette = await api('POST', '/casino/play', {
    gameId: 'roulette', stake: 1, betType: 'number', number: 7,
  }, t, { 'Idempotency-Key': 'roulette-round-1' });
  assert.equal(roulette.status, 201);
  assert.ok(roulette.body.outcome.number >= 0 && roulette.body.outcome.number <= 36);
  assert.equal(roulette.body.wallet.balance, beforeRoulette - 1 + roulette.body.payout);
  const rouletteReplay = await api('POST', '/casino/play', {
    gameId: 'roulette', stake: 1, betType: 'number', number: 7,
  }, t, { 'Idempotency-Key': 'roulette-round-1' });
  assert.equal(rouletteReplay.body.roundId, roulette.body.roundId);
  assert.equal((await api('GET', '/wallet', undefined, t)).body.balance, roulette.body.wallet.balance);

  const beforeSlots = roulette.body.wallet.balance;
  const slots = await api('POST', '/casino/play', { gameId: 'slots', stake: 1 }, t, { 'Idempotency-Key': 'slots-round-1' });
  assert.equal(slots.status, 201);
  assert.equal(slots.body.outcome.symbols.length, 3);
  assert.ok(slots.body.outcome.symbols.every((symbol: string) => ['CHERRY', 'LEMON', 'BELL', 'BAR', 'STAR', 'SEVEN'].includes(symbol)));
  assert.equal(slots.body.wallet.balance, beforeSlots - 1 + slots.body.payout);
});

test('jackpot entries debit cash once and settle a verifiable full-pool prize', async () => {
  const token = (await reg('jackpot@test.io', '+2348000000011')).body.accessToken;
  const admin = (await api('POST', '/auth/login', { identifier: 'admin@test.io', password: 'adminpass123' })).body.accessToken;
  await makeEligible(token, admin);
  assert.equal((await api('POST', '/wallet/deposit', { method: 'visa', amount: 250 }, token)).status, 201);

  const headers = { 'Idempotency-Key': 'jackpot-entry-1' };
  const entered = await api('POST', '/jackpot/entries', { quantity: 2 }, token, headers);
  assert.equal(entered.status, 201);
  assert.equal(entered.body.draw.pool, 200);
  assert.equal(entered.body.draw.myEntries, 2);
  assert.equal(entered.body.wallet.withdrawable, 50);
  const replay = await api('POST', '/jackpot/entries', { quantity: 2 }, token, headers);
  assert.equal(replay.body.draw.entryCount, 2);
  assert.equal((await api('GET', '/wallet', undefined, token)).body.withdrawable, 50);

  const { db } = await import('../src/db.js');
  db.prepare('UPDATE jackpot_draws SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), entered.body.draw.id);
  const settled = await api('GET', '/jackpot', undefined, token);
  assert.equal(settled.body.draw.status, 'drawn');
  assert.equal(settled.body.draw.prize, 200);
  assert.equal(settled.body.draw.hasWinner, true);
  assert.equal(createHash('sha256').update(settled.body.draw.revealedSeed).digest('hex'), settled.body.draw.seedHash);
  const verification = await api('GET', `/jackpot/draws/${entered.body.draw.id}/verification`);
  assert.equal(verification.status, 200);
  const { entryIds, selectionCounter, winningEntryIndex } = verification.body;
  assert.equal(entryIds.length, 2);
  const bound = 1n << 52n;
  const limit = bound - (bound % BigInt(entryIds.length));
  let reproducedIndex = -1;
  for (let counter = 0; counter <= selectionCounter; counter++) {
    const digest = createHmac('sha256', verification.body.revealedSeed)
      .update(`${verification.body.drawId}:${entryIds.join(',')}:${counter}`)
      .digest('hex');
    const sample = BigInt(`0x${digest.slice(0, 13)}`);
    if (sample < limit) {
      assert.equal(counter, selectionCounter);
      reproducedIndex = Number(sample % BigInt(entryIds.length));
      break;
    }
  }
  assert.equal(reproducedIndex, winningEntryIndex);
  assert.equal(entryIds[winningEntryIndex], verification.body.winningEntryId);
  assert.equal((await api('GET', '/wallet', undefined, token)).body.withdrawable, 250);
  const transactions = await api('GET', '/wallet/transactions?limit=100', undefined, token);
  assert.ok(transactions.body.transactions.some((item: any) => item.type === 'bet' && item.method.includes('jackpot')));
  assert.ok(transactions.body.transactions.some((item: any) => item.type === 'win' && item.method.includes('jackpot')));
});
