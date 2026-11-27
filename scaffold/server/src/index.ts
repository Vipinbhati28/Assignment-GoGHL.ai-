import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { config, instanceId } from './config.js';
import { ensureIndexes } from './db.js';
import { api } from './http/api.js';
import { auth } from './http/auth.js';
import { grader } from './http/grader.js';
import { webhooks } from './http/webhooks.js';
import { startDispatcher } from './outbox/dispatcher.js';
import { attachWebSockets } from './realtime/ws.js';
import { getRedis } from './redis.js';

const app = express();
app.disable('x-powered-by');
let ready = false;

// 200 only once indexes exist and background work runs: the check waits for it.
app.get('/healthz', (_req, res) => {
  res.status(ready ? 200 : 503).json({ ok: ready, instance: instanceId });
});

app.use(webhooks); // raw body; must come before the JSON parser
app.use(express.json({ limit: '100kb' }));
app.use(auth);
app.use(api);
app.use(grader);

app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('[http] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

const server = createServer(app);

async function main() {
  await ensureIndexes();
  await getRedis().ping();
  await attachWebSockets(server);
  await startDispatcher();
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  ready = true;
  console.log(`[boot] ${instanceId} ready on http://localhost:${config.port}`);
}

main().catch((e) => {
  console.error('[boot] failed', e);
  process.exit(1);
});
