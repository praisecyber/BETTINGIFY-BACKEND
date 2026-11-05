import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp } from './app.js';
import { AppError } from './lib/errors.js';
import { verifyAccess, type AuthUser } from './lib/auth.js';
import { displayName } from './routes/aviator.js';
import { walletDto } from './routes/me.js';
import { seedReferenceData } from './seed.js';
import { aviator } from './services/aviator.js';
import { z } from 'zod';

export async function startBackendServer(port: number, host = '0.0.0.0') {
  await seedReferenceData();
  const server = createServer(createApp());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws/aviator') return socket.destroy();
    const user = url.searchParams.get('token') ? verifyAccess(url.searchParams.get('token')!) : null;
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  aviator.start();

  return {
    server,
    close: async () => {
      aviator.stop();
      for (const ws of wss.clients) ws.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

const send = (ws: WebSocket, message: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));

function onConnect(ws: WebSocket, user: AuthUser | null) {
  send(ws, { type: 'state', authenticated: !!user, ...aviator.snapshot(), myBet: user ? aviator.myBet(user.id) : null, wallet: user ? walletDto(user.id) : null });
  const onEvent = (message: unknown) => send(ws, message);
  const onUser = (userId: string, message: unknown) => { if (user?.id === userId) send(ws, message); };
  aviator.on('event', onEvent);
  aviator.on('user', onUser);
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 20_000);
  ws.on('close', () => {
    clearInterval(heartbeat);
    aviator.off('event', onEvent);
    aviator.off('user', onUser);
  });
  ws.on('message', (raw) => {
    try {
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Connect with a token to play');
      const message = JSON.parse(raw.toString());
      if (message.type === 'bet') {
        const bet = z.object({ amount: z.number().positive().max(100000), autoCashout: z.number().min(1.01).max(1000).optional() }).parse(message);
        aviator.placeBet(user.id, displayName(user.id), Math.round(bet.amount * 100), bet.autoCashout);
        send(ws, { type: 'bet_placed', wallet: walletDto(user.id) });
      } else if (message.type === 'cashout') {
        const result = aviator.cashout(user.id);
        send(ws, { type: 'cashout_ok', ...result, wallet: walletDto(user.id) });
      } else if (message.type === 'cancel') {
        aviator.cancelBet(user.id);
        send(ws, { type: 'bet_cancelled', wallet: walletDto(user.id) });
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      send(ws, { type: 'error', code: err.code ?? 'BAD_MESSAGE', message: err.message });
    }
  });
}

export type RunningBackend = Awaited<ReturnType<typeof startBackendServer>>;
export type BackendHttpServer = Server;
