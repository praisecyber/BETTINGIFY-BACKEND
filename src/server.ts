import { config } from './config.js';
import { startBackendServer } from './runtime.js';
import { settleDueJackpotDraws } from './services/jackpot.js';

const backend = await startBackendServer(config.port);
const address = backend.server.address();
console.log(`[bettingify] API on :${typeof address === 'object' && address ? address.port : config.port}  (ws: /ws/aviator)`);

const settleJackpot = () => {
  try {
    settleDueJackpotDraws();
  } catch (error) {
    console.error('[bettingify] jackpot settlement failed', error);
  }
};
settleJackpot();
const jackpotTimer = setInterval(settleJackpot, 15_000);
jackpotTimer.unref();

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(jackpotTimer);
  void backend.close().then(() => process.exit(0)).catch((error: unknown) => {
    console.error('[bettingify] shutdown failed', error);
    process.exit(1);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
