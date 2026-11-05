# Bettingify Backend

Node 22 + Express + TypeScript + SQLite (built-in `node:sqlite`, no native deps). Lives in `backend/`, separate from `frontend/`.

## Run
```bash
cd backend && npm install
cp .env.example .env      # set JWT_SECRET, WEBHOOK_SECRET, ADMIN_EMAIL/PASSWORD
npm run dev               # http://localhost:4000  (ws: /ws/aviator)
npm test                  # end-to-end tests (in-memory DB)
npm run build && npm start
```
Needs Node >= 22.13. First start seeds matches, payment methods, promotions, games and the admin user.

## Database migration
To copy the existing SQLite database into MongoDB Atlas without deleting or modifying the SQLite source:
```bash
# Set MONGODB_URI privately in backend/.env, then:
npm run migrate:mongodb
```
The migration uses `MONGODB_DB` (default `bettingify`), copies each SQLite table to a collection of the same name, keeps stable document IDs, inserts missing documents without overwriting existing ones, and verifies copied documents. Back up the SQLite file and stop the backend before migrating so the source remains consistent. This copy command does not switch the application runtime from SQLite; the backend must be converted to async MongoDB repositories before Atlas can serve live application traffic.

## Conventions
- Base URL `/api/v1`. `Authorization: Bearer <accessToken>` (15 min) + rotating refresh token.
- Amounts in/out are major units (e.g. `10.5`), stored as integer cents. Odds are decimals.
- Errors: `{ "error": { "code", "message", "details?" } }`.
- `Idempotency-Key` header supported on deposit, withdraw, bet, cashout.
- OpenAPI 3.1 / Swagger document: [`openapi.json`](./openapi.json). Import it into Swagger UI to browse the documented routes.

## Wallet model
`cash` (withdrawable) + `bonus` (locked). Stakes use cash first, then bonus. Bonus unlocks into cash once
`bonus x BONUS_WAGER_MULT` has been staked. All balance changes go through one function and write an append-only `ledger` row.

## Endpoints
- Auth: `POST /auth/register|login|refresh|logout`, `POST /auth/email/resend|verify`, `POST /auth/password/forgot|reset`
- Me: `GET/PATCH /me`, `POST /me/password`, `POST /me/verification`, `PATCH /me/deposit-limits`, `POST /me/self-exclude`, `GET /me/matches`
- Wallet: `GET /wallet`, `GET /wallet/methods?kind=`, `POST /wallet/deposit`, `POST /wallet/withdraw`, `POST /wallet/withdrawals/:id/cancel`, `GET /wallet/transactions`
- Sports/results: `GET /matches?sport=&live=true&q=&status=scheduled|live|finished|cancelled`, `GET /matches/:id`, `GET /sports`
- External provider feeds: `GET /sports-feed/events?date=YYYY-MM-DD&sport=Soccer` (TheSportsDB), `GET /sports-feed/sportapi/events?date=YYYY-MM-DD` (SportAPI), `GET /sports-feed/sportapi/teams/:id/logo` (SportAPI team-logo proxy), `GET /sports-feed/odds/sports` (active sports catalog), `GET /sports-feed/odds?sportKey=soccer_epl&regions=us,us2,uk,eu,au&markets=h2h` (The Odds API)
- Bets: `POST /bets`, `POST /bets/accumulator`, `GET /bets?status=open|settled`, `GET /bets/:id`, `POST /bets/:id/cashout`
- Gifts: `GET /gifts`, `POST /gifts/:id/claim`
- Content: `GET /promotions`, `GET /games`
- Casino: `POST /casino/play` (`gameId:"roulette"|"slots"`, `stake`, and for roulette `betType:"red"|"black"|"number"` with `number` from 0 to 36). Requires authentication and gambling eligibility; send `Idempotency-Key` on retries.
- Jackpot: `GET /jackpot`, `POST /jackpot/entries` (`{quantity}`; authenticated, eligible users only; send `Idempotency-Key`). Weekly pool entries debit withdrawable cash only; a draw seed commitment is published before closing and revealed after settlement. Paid entries are disabled unless `JACKPOT_ENABLED=true`.
- Aviator: `GET /aviator/state|history|rounds/:id|my-bet`, `POST /aviator/bet|bet/cancel|cashout`
- Webhook: `POST /webhooks/payments` (HMAC-SHA256 of raw body in `x-signature`)
- Admin: `GET /admin/payments|stats|users`, `GET /admin/users/:id/verification-events`, `POST /admin/withdrawals/:id/approve|reject`, `POST /admin/deposits/:id/confirm|fail`, `POST /admin/matches`, `POST /admin/matches/:id/settle|cancel`, `PATCH /admin/matches/:id`, `PATCH /admin/users/:id/status|verification`

## Club badge assets
Download badges for every club in a SportAPI date feed into `frontend/public/assets/club-badges` and write/update its local manifest:
```bash
npm run sync:club-badges
# Or specify a date: npm run sync:club-badges -- 2026-11-04
```
The app loads saved badge files from `public`; clubs not yet synced continue to use the server-side SportAPI logo proxy. Each run adds badges for that date's fixtures; the provider's daily feed does not enumerate every club worldwide.

Bodies:
```
register {email, phone, password, firstName, lastName, dateOfBirth:"YYYY-MM-DD", acceptedTerms:true, referralCode?}
login    {identifier (email or phone), password}
deposit  {method, amount, claimWelcomeBonus?}
withdraw {method, amount, destination?}
bet      {matchId, selection:"home"|"draw"|"away", stake, expectedOdds?}   // 409 ODDS_CHANGED if stale
accumulator {legs:[{matchId, selection, expectedOdds?}, ...], stake}        // 2-20 distinct matches
settle   {result:"home"|"draw"|"away", score?}
```

## Account safety and provider boundaries
- Registration requires a date of birth and checks `MIN_GAMBLING_AGE` (18 by default for local development). Production startup requires the licensed market's value explicitly.
- Betting, deposits, and withdrawals require verified email, age, and identity. The development build has no mail or KYC vendor: resend/reset endpoints return a development-only token, and `/me/verification` creates a pending manual-review request. An admin reviews the DOB and checks identity externally using `PATCH /admin/users/:id/verification` with a required audit note; status changes are stored in `account_verification_events` and readable through `/admin/users/:id/verification-events`. No identity documents are accepted or transmitted.
- Email token records store only token hashes and expire (email verification: 24 hours; password reset: 1 hour). Production email endpoints return `503 EMAIL_DELIVERY_UNAVAILABLE` until a delivery provider is integrated; they do not pretend to send mail.
- `PATCH /me/deposit-limits` accepts `{daily, monthly}` in dollars (or `null` to remove a cap). Limits apply to UTC calendar periods and count pending, processing, and completed deposits. `POST /me/self-exclude` accepts `{duration:"24h"|"7d"|"30d"|"6m"|"permanent"}`; an exclusion cannot be shortened or removed by the user. It blocks wagering, deposits, and bonus claims; withdrawals remain available.
- Accumulators accept 2-20 distinct-match selections. Odds are combined and revalidated server-side at placement, settlement waits for every leg, a losing leg settles the ticket as lost, and cancellation of any leg voids/refunds the full ticket. Accumulators cannot be cashed out.
- The live-betting board lists `/matches?status=live` markets, groups them by sport and competition, and uses the existing bet slip to place selections against server-validated odds. Live scores and prices are admin-managed and the board polls every 15 seconds. The upcoming/results tabs use the same internal markets. The `/sports-feed/*` endpoints proxy TheSportsDB, SportAPI and The Odds API server-side; provider keys are read only from backend environment variables (`THESPORTSDB_API_KEY`, `SPORTAPI_API_KEY`, `ODDS_API_KEY`). Responses are cached for 60 seconds. Third-party events and bookmaker quotes are informational only: they do not create bettable markets and must not be used for wager settlement. Connect a licensed live data/odds provider before using the admin-managed markets for real-money live betting.
- Sample sports fixtures are inserted only when `DEMO_DATA=true`. The default is off; startup removes unused seeded examples and cancels any such records already referenced by bets, preserving bet history. Admin-entered markets remain manually managed and are not verified real-time data. The live betting page shows provider fixtures and odds across all countries covered by the selected sport and configured feed. The Odds API region setting identifies bookmaker quote regions, not the event's country; `us,us2,uk,eu,au` combines its supported quote regions. Active sports are loaded from the provider's sports catalog. Provider odds remain read-only and do not populate bettable markets because quote updates, bet acceptance, event identity, and settlement must first be integrated and validated server-side.
- Virtual Football reuses internal markets with the exact sport name `Virtual Football`; only fixtures and results entered through admin controls are shown. Connect an approved virtual-sports provider before accepting real-money virtual bets. Live Scores are sourced from the existing SportAPI informational feed and do not create bettable markets. Live Games are intentionally unavailable until an approved provider, credentials, jurisdiction checks, and server-side wallet/settlement integration are in place.
- Jackpot defaults: disabled, ₦100 per entry, maximum 10 entries per user per weekly draw. Configure `JACKPOT_ENABLED=true` only after regulatory approval and final terms. Draws close Monday at 00:00 UTC; the full entry pool is paid to one winner with no operator fee. A SHA-256 seed commitment is published before the draw and the seed is revealed after settlement. Empty rounds are void. The backend checks for due draws at startup and every 15 seconds; entries debit withdrawable cash and require the usual eligibility checks.
- Jackpot verification: `GET /jackpot/draws/:id/verification` returns the revealed seed, sorted non-personal ticket IDs, accepted HMAC sample counter, winning ticket index, and algorithm details for completed draws.
- Roulette and slots outcomes are generated server-side and casino rounds are written to `casino_rounds`; stakes and returns use the wallet ledger and require the same eligibility checks as other gambling actions. These built-in games do not use external daily event data.

## Aviator (real-time)
`ws://host/ws/aviator?token=<accessToken>` (no token = spectator).
Server events: `state, betting, flying, tick, players, crashed, cashed_out, lost, error`.
Client messages: `{type:"bet",amount,autoCashout?}`, `{type:"cashout"}`, `{type:"cancel"}`.
Server-authoritative: crash point fixed before the round; cash-outs validated against the server clock.
Provably fair: `sha256(serverSeed)` published at round start, seed revealed on crash (`GET /aviator/rounds/:id`).
`r = parseInt(HMAC_SHA256(serverSeed, roundId).hex.slice(0,13), 16)`; `r % 33 == 0` -> 1.00x, else `floor((100*2^52 - r)/(2^52 - r))/100` (~97% RTP).

This is Bettingify's own server-run crash-game implementation, not Spribe's Aviator game. No Spribe provider credentials or integration are configured; the UI labels this distinction. Only use Spribe content after authorized commercial onboarding and a server-side integration., else `floor((100*2^52 - r)/(2^52 - r))/100` (~97% RTP).
Curve: `1 + t^1.5 * 0.4` (same as the current frontend). Rounds interrupted by a restart are refunded on boot.

## Before real money
- Gambling licence for Nigeria (NLRC / relevant state regulators).
- Real payment provider: implement `PaymentProvider` in `services/payments.ts` (Paystack, Flutterwave, crypto processor) with hosted checkout; never accept raw card numbers.
- Replace development tokens and manual verification with audited email delivery and licensed KYC/age/AML providers; configure minimum age for the jurisdiction and independently validate all compliance requirements.
- Connect an authorized, licensed live odds/results supplier; current feed is admin-managed and client-polled.
- Review responsible-gambling limit-increase cooling-off requirements, self-exclusion rules, 2FA, audited RNG, and operational procedures for the target jurisdiction.
- Consider Postgres and further operational controls for scale.
