import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import { newId, nowIso, run, tx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { fromCents } from '../lib/money.js';
import { requireGamblingEligible } from './account.js';
import { creditReturn, debitStake } from './wallet.js';

const redNumbers = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const slotSymbols = ['CHERRY', 'LEMON', 'BELL', 'BAR', 'STAR', 'SEVEN'] as const;
const slotMultipliers: Record<typeof slotSymbols[number], number> = {
    CHERRY: 12, LEMON: 16, BELL: 20, BAR: 28, STAR: 44, SEVEN: 80,
};

export type CasinoGameId = 'roulette' | 'slots';
type RouletteBet = { type: 'red' | 'black' } | { type: 'number'; number: number };

function validateStake(stake: number) {
    if (stake < config.minStakeCents || stake > config.maxStakeCents)
        throw badRequest('STAKE_OUT_OF_RANGE', `Stake must be between ${fromCents(config.minStakeCents)} and ${fromCents(config.maxStakeCents)}`);
}

export function playRoulette(userId: string, stake: number, bet: RouletteBet) {
    validateStake(stake);
    if (bet.type === 'number' && (!Number.isInteger(bet.number) || bet.number < 0 || bet.number > 36))
        throw badRequest('INVALID_ROULETTE_NUMBER', 'Choose a number from 0 to 36');

    const roundId = newId('casino');
    return tx(() => {
        requireGamblingEligible(userId);
        const split = debitStake(userId, stake, { refType: 'casino_round', refId: roundId, description: 'Roulette stake' });
        const number = randomInt(0, 37);
        const color = number === 0 ? 'green' : redNumbers.has(number) ? 'red' : 'black';
        const won = bet.type === 'number' ? number === bet.number : color === bet.type;
        const payout = won ? stake * (bet.type === 'number' ? 36 : 2) : 0;
        const choice = bet.type === 'number' ? { type: bet.type, number: bet.number } : { type: bet.type };
        const outcome = { number, color, won, multiplier: won ? (bet.type === 'number' ? 36 : 2) : 0 };

        if (payout) creditReturn(userId, payout, { total: stake, cash: split.fromCash, bonus: split.fromBonus }, {
            type: 'win', refType: 'casino_round', refId: roundId, description: 'Roulette payout',
        });
        run(`INSERT INTO casino_rounds (id,user_id,game_id,stake,stake_cash,stake_bonus,choice,outcome,payout,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, roundId, userId, 'roulette', stake, split.fromCash, split.fromBonus,
            JSON.stringify(choice), JSON.stringify(outcome), payout, nowIso());

        return { roundId, gameId: 'roulette' as const, stake: fromCents(stake), choice, outcome, payout: fromCents(payout), net: fromCents(payout - stake) };
    });
}

export function playSlots(userId: string, stake: number) {
    validateStake(stake);
    const roundId = newId('casino');
    return tx(() => {
        requireGamblingEligible(userId);
        const split = debitStake(userId, stake, { refType: 'casino_round', refId: roundId, description: 'Slots stake' });
        const symbols = Array.from({ length: 3 }, () => slotSymbols[randomInt(0, slotSymbols.length)]);
        const multiplier = symbols.every((symbol) => symbol === symbols[0]) ? slotMultipliers[symbols[0]] : 0;
        const payout = stake * multiplier;
        const choice = { type: 'spin' };
        const outcome = { symbols, multiplier };

        if (payout) creditReturn(userId, payout, { total: stake, cash: split.fromCash, bonus: split.fromBonus }, {
            type: 'win', refType: 'casino_round', refId: roundId, description: 'Slots payout',
        });
        run(`INSERT INTO casino_rounds (id,user_id,game_id,stake,stake_cash,stake_bonus,choice,outcome,payout,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, roundId, userId, 'slots', stake, split.fromCash, split.fromBonus,
            JSON.stringify(choice), JSON.stringify(outcome), payout, nowIso());

        return { roundId, gameId: 'slots' as const, stake: fromCents(stake), outcome, payout: fromCents(payout), net: fromCents(payout - stake) };
    });
}