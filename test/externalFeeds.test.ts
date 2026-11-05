import test from 'node:test';
import assert from 'node:assert/strict';
import { getOdds } from '../src/services/oddsFeed.js';
import { getSportApiDay, getSportApiTeamLogo } from '../src/services/sportApiFeed.js';

test('provider adapters authenticate server-side, normalize data, and cache responses', async () => {
  const originalFetch = globalThis.fetch;
  let sportApiRequests = 0;
  let basketballApiRequests = 0;
  let teamLogoRequests = 0;
  let oddsApiRequests = 0;
  let oddsSportsRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'sportapi.ai') {
      if (url.pathname === '/api/teams/42/logo') {
        teamLogoRequests++;
        assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'sportapi-test-key');
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url.pathname === '/api/teams/19/logo') {
        assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'sportapi-test-key');
        return new Response(new Uint8Array([255, 216, 255]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.pathname === '/api/basketball/games/date/2026-11-03') {
        basketballApiRequests++;
        assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'sportapi-test-key');
        return new Response(JSON.stringify({
          success: true,
          data: [{
            id: 7001, start: '2026-11-03T19:00:00Z', status: 'Q2', live: true,
            league: { name: 'NBA' },
            home: { id: 11, name: 'Home Hoops', logo_url: 'https://cdn.example.com/home.png', score: 57 },
            away: { id: 22, name: 'Away Hoops', logo_url: 'https://cdn.example.com/away.png', score: 49 },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      sportApiRequests++;
      assert.equal(url.pathname, '/api/fixtures/date/2026-11-03');
      assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'sportapi-test-key');
      return new Response(JSON.stringify({
        success: true,
        date: '2026-11-03',
        data: [{
          id: 42, home_id: 42, away_id: 43, kickoff_utc: '2026-11-03T18:00:00Z', home_score: 2, away_score: 1,
          status: 'FT', league_name: 'Test League', home_team: 'Home FC', away_team: 'Away FC', winner: 'home',
          home_logo: 'https://cdn.example.com/home.png', away_logo: 'https://cdn.example.com/away.png',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'api.the-odds-api.com') {
      if (url.pathname === '/v4/sports/') {
        oddsSportsRequests++;
        assert.equal(url.searchParams.get('apiKey'), 'odds-test-key');
        return new Response(JSON.stringify([
          { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: 'England', active: true, has_outrights: false },
          { key: 'americanfootball_nfl', group: 'American Football', title: 'NFL', description: 'USA', active: false, has_outrights: false },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      oddsApiRequests++;
      assert.equal(url.pathname, '/v4/sports/soccer_epl_test/odds/');
      assert.equal(url.searchParams.get('apiKey'), 'odds-test-key');
      assert.equal(url.searchParams.get('regions'), 'uk');
      assert.equal(url.searchParams.get('markets'), 'h2h');
      assert.equal(url.searchParams.get('oddsFormat'), 'decimal');
      return new Response(JSON.stringify([{
        id: 'event-1', sport_key: 'soccer_epl_test', sport_title: 'Test League',
        commence_time: '2026-11-03T18:00:00Z', home_team: 'Home FC', away_team: 'Away FC',
        bookmakers: [{
          key: 'testbook', title: 'Test Book', last_update: '2026-11-03T17:00:00Z',
          markets: [{
            key: 'h2h', outcomes: [
              { name: 'Home FC', price: 2.1 }, { name: 'Away FC', price: 3.2 }, { name: 'Draw', price: 3.4 },
            ]
          }],
        }],
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected provider request to ${url.hostname}`);
  };

  try {
    const fixtures = await getSportApiDay('2026-11-03', 'sportapi-test-key');
    assert.equal(fixtures.provider, 'SportAPI');
    assert.equal(fixtures.events.length, 2);
    assert.deepEqual(fixtures.events[0], {
      id: 'sportapi:42', sport: 'Football', league: 'Test League', home: 'Home FC', away: 'Away FC',
      startsAt: '2026-11-03T18:00:00.000Z', status: 'finished', score: '2 - 1', result: 'home',
      homeLogo: '/sports-feed/sportapi/teams/42/logo', awayLogo: '/sports-feed/sportapi/teams/43/logo',
    });
    await getSportApiDay('2026-11-03', 'sportapi-test-key');
    assert.equal(sportApiRequests, 1);
    assert.equal(basketballApiRequests, 1);
    assert.deepEqual(fixtures.events[1], {
      id: 'sportapi:basketball:7001', sport: 'Basketball', league: 'NBA', home: 'Home Hoops', away: 'Away Hoops',
      startsAt: '2026-11-03T19:00:00.000Z', status: 'live', score: '57 - 49', result: null,
      homeLogo: 'https://cdn.example.com/home.png', awayLogo: 'https://cdn.example.com/away.png',
    });

    const logo = await getSportApiTeamLogo(42, 'sportapi-test-key');
    assert.equal(logo.contentType, 'image/png');
    assert.deepEqual([...logo.body], [137, 80, 78, 71]);
    assert.equal(teamLogoRequests, 1);
    await getSportApiTeamLogo(42, 'sportapi-test-key');
    assert.equal(teamLogoRequests, 1);
    const jpegLogo = await getSportApiTeamLogo(19, 'sportapi-test-key');
    assert.equal(jpegLogo.contentType, 'image/jpeg');
    assert.deepEqual([...jpegLogo.body], [255, 216, 255]);

    const odds = await getOdds('soccer_epl_test', 'uk', 'h2h', 'odds-test-key');
    assert.equal(odds.provider, 'The Odds API');
    assert.equal(odds.events[0].bookmakers[0].markets[0].outcomes[0].price, 2.1);
    assert.equal(JSON.stringify(odds).includes('odds-test-key'), false);
    await getOdds('soccer_epl_test', 'uk', 'h2h', 'odds-test-key');
    assert.equal(oddsApiRequests, 1);
    const { getOddsSports } = await import('../src/services/oddsFeed.js');
    const sports = await getOddsSports('odds-test-key');
    assert.deepEqual(sports.map((sport) => sport.key), ['soccer_epl']);
    await getOddsSports('odds-test-key');
    assert.equal(oddsSportsRequests, 1);
    await assert.rejects(getOdds('missing_key_test', 'us', 'h2h', ''), (error: { code?: string }) => error.code === 'ODDS_API_KEY_NOT_CONFIGURED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
