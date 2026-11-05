import { all, get, nowIso, run } from './db.js';
import { config } from './config.js';
import { hashPassword } from './lib/auth.js';
import { newId } from './db.js';
import { ensureWallet } from './services/wallet.js';
import { randomBytes } from 'node:crypto';

const h = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

export async function seedReferenceData() {
  if (!get('SELECT 1 FROM payment_methods LIMIT 1')) {
    const pm = [
      ['visa', 'Visa', 1000, 500000, 'Instant', 'card', 1, 1],
      ['mastercard', 'Mastercard', 1000, 500000, 'Instant', 'card', 1, 1],
      ['crypto', 'Crypto (BTC/ETH)', 2000, 5000000, '10-30 min', 'bitcoin', 1, 1],
      ['bank', 'Bank Transfer', 5000, 1000000, '1-3 days', 'bank', 1, 1],
      ['paypal', 'PayPal', 1000, 200000, 'Instant', 'wallet', 1, 0],
    ] as const;
    for (const m of pm) run('INSERT INTO payment_methods (id,name,min_amount,max_amount,eta,icon,can_deposit,can_withdraw) VALUES (?,?,?,?,?,?,?,?)', ...m);
  }
  if (!config.demoData) {
    run(`DELETE FROM matches WHERE NOT EXISTS (SELECT 1 FROM bets WHERE bets.match_id = matches.id)
      AND NOT EXISTS (SELECT 1 FROM bet_legs WHERE bet_legs.match_id = matches.id)
      AND (
      (id = 'm1' AND home = 'Arsenal' AND away = 'Chelsea') OR
      (id = 'm2' AND home = 'Real Madrid' AND away = 'Barcelona') OR
      (id = 'm3' AND home = 'Lakers' AND away = 'Celtics') OR
      (id = 'm4' AND home = 'Alcaraz' AND away = 'Sinner') OR
      (id = 'm5' AND home = 'Bayern Munich' AND away = 'Dortmund') OR
      (id = 'm6' AND home = 'Mumbai Indians' AND away = 'Chennai Kings') OR
      (id = 'm7' AND home = 'Team Liquid' AND away = 'Cloud9') OR
      (id = 'm8' AND home = 'Juventus' AND away = 'Inter Milan'))`);
    run(`UPDATE matches SET status = 'cancelled' WHERE
      (id = 'm1' AND home = 'Arsenal' AND away = 'Chelsea') OR
      (id = 'm2' AND home = 'Real Madrid' AND away = 'Barcelona') OR
      (id = 'm3' AND home = 'Lakers' AND away = 'Celtics') OR
      (id = 'm4' AND home = 'Alcaraz' AND away = 'Sinner') OR
      (id = 'm5' AND home = 'Bayern Munich' AND away = 'Dortmund') OR
      (id = 'm6' AND home = 'Mumbai Indians' AND away = 'Chennai Kings') OR
      (id = 'm7' AND home = 'Team Liquid' AND away = 'Cloud9') OR
      (id = 'm8' AND home = 'Juventus' AND away = 'Inter Milan')`);
  } else if (!get('SELECT 1 FROM matches LIMIT 1')) {
    const rows: [string, string, string, string, string, number, 'scheduled' | 'live', string | null, number, number, number][] = [
      ['m1', 'Football', 'Premier League', 'Arsenal', 'Chelsea', -1, 'live', '1 - 0', 2100, 3400, 2850],
      ['m2', 'Football', 'La Liga', 'Real Madrid', 'Barcelona', 3, 'scheduled', null, 1950, 3600, 2500],
      ['m3', 'Basketball', 'NBA', 'Lakers', 'Celtics', -1, 'live', '78 - 72', 1800, 0, 2000],
      ['m4', 'Tennis', 'ATP Masters', 'Alcaraz', 'Sinner', 2, 'scheduled', null, 2200, 0, 1650],
      ['m5', 'Football', 'Bundesliga', 'Bayern Munich', 'Dortmund', 20, 'scheduled', null, 1550, 4200, 3800],
      ['m6', 'Cricket', 'IPL', 'Mumbai Indians', 'Chennai Kings', 18, 'scheduled', null, 1900, 0, 1900],
      ['m7', 'Esports', 'LCS', 'Team Liquid', 'Cloud9', -1, 'live', '1 - 1', 1700, 0, 2100],
      ['m8', 'Football', 'Serie A', 'Juventus', 'Inter Milan', 26, 'scheduled', null, 2400, 3100, 2750],
    ];
    for (const r of rows) run('INSERT INTO matches (id,sport,league,home,away,starts_at,status,score,odds_home,odds_draw,odds_away) VALUES (?,?,?,?,?,?,?,?,?,?,?)', r[0], r[1], r[2], r[3], r[4], h(r[5]), r[6], r[7], r[8], r[9], r[10]);
  }
  if (!get('SELECT 1 FROM promotions LIMIT 1')) {
    const img = (id: string) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=600`;
    const ps = [
      ['p1', '100% Welcome Bonus', 'Get a 100% match on your first deposit up to ₦500', '₦500', img('7771003'), 'New Players'],
      ['p4', 'Free Bet Friday', 'Place 3 bets during the week, get a ₦10 free bet every Friday', '₦10', img('248547'), 'Weekly'],
      ['p5', 'VIP Reload Bonus', 'Exclusive 50% reload bonus for VIP members every month', '50%', img('7771003'), 'VIP'],
      ['p6', 'Refer a Friend', 'Invite friends and earn ₦25 for each one who joins', '₦25', img('3184292'), 'Refer'],
    ];
    ps.forEach((p, i) => run('INSERT INTO promotions (id,title,description,reward,image,tag,sort) VALUES (?,?,?,?,?,?,?)', ...p, i));
  }
  run("UPDATE promotions SET active = 0 WHERE title IN ('Aviator Cashback','Acca Boost')");
  if (!get('SELECT 1 FROM games LIMIT 1')) {
    const img = (id: string) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=400`;
    const gs = [
      ['aviator', 'Aviator', img('7771003'), 'Trending', '97%', 1],
      ['slots', 'Lucky Slots', img('9428986'), 'Hot', '96%', 0],
      ['roulette', 'European Roulette', img('9060168'), 'Classic', '97.3%', 0],
      ['blackjack', 'Blackjack VIP', img('2693208'), 'Live', '99%', 0],
      ['poker', "Texas Hold'em", img('262367'), 'Tournament', '98%', 0],
      ['dice', 'Lightning Dice', img('6957088'), 'New', '96.5%', 0],
      ['wheel', 'Crazy Wheel', img('2693208'), 'Hot', '96%', 0],
      ['baccarat', 'Baccarat Pro', img('9060168'), 'VIP', '98.9%', 0],
    ];
    gs.forEach((g, i) => run('INSERT INTO games (id,name,image,tag,rtp,playable,sort) VALUES (?,?,?,?,?,?,?)', ...g, i));
  }
  if (config.adminEmail && config.adminPassword && !get("SELECT 1 FROM users WHERE role = 'admin'")) {
    const id = newId('usr');
    run(`INSERT INTO users (id,email,phone,password_hash,first_name,last_name,role,referral_code,terms_accepted_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, id, config.adminEmail.toLowerCase(), '+0000000000', await hashPassword(config.adminPassword), 'Admin', 'User', 'admin', randomBytes(4).toString('hex').toUpperCase(), nowIso(), nowIso());
    ensureWallet(id);
    console.log(`[seed] admin created: ${config.adminEmail}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedReferenceData();
  console.log('[seed] done', all('SELECT COUNT(*) c FROM matches'));
}
