import { config, instanceId } from '../config.js';
import { col, type MessageDoc } from '../db.js';
import { emit } from '../realtime/events.js';
import { getSubscriber, keys } from '../redis.js';
import { sendMessage } from './pigeonClient.js';
import { startCoolOff, takeToken, tripBreaker } from './rateLimit.js';

// A lease outlives one HTTP attempt (4 s timeout) with margin. If the holder
// dies (kill -9), any instance reclaims the job once the lease runs out.
const LEASE_MS = 10_000;
const MAX_CONCURRENT = 8;
const POLL_MS = 250;
const BREAKER_MS = 1000;

let active = 0;
let pumping = false;
let again = false;
let timer: NodeJS.Timeout | undefined;

type Job = MessageDoc & { _id: NonNullable<MessageDoc['_id']> };

async function claimNext(): Promise<Job | null> {
  const messages = await col.messages();
  const now = new Date();
  const job = await messages.findOneAndUpdate(
    {
      direction: 'out',
      $or: [
        { send_state: 'pending', next_attempt_at: { $lte: now } },
        { send_state: 'inflight', lease_until: { $lt: now } },
      ],
    },
    { $set: { send_state: 'inflight', lease_owner: instanceId, lease_until: new Date(now.getTime() + LEASE_MS) } },
    { sort: { next_attempt_at: 1 }, returnDocument: 'after' },
  );
  return job as Job | null;
}

// Only touches the job if we still hold its lease, so a status webhook that
// already marked it done (or another instance that took it over) wins.
async function release(job: Job, delayMs: number, error: string | null, countAttempt: boolean) {
  const messages = await col.messages();
  await messages.updateOne(
    { _id: job._id, send_state: 'inflight', lease_owner: instanceId },
    {
      $set: { send_state: 'pending', next_attempt_at: new Date(Date.now() + delayMs), lease_owner: null, lease_until: null, last_error: error },
      ...(countAttempt ? { $inc: { attempts: 1 } } : {}),
    },
  );
}

const backoff = (attempts: number) => Math.min(2000, 200 * 2 ** Math.min(attempts, 4));

async function processJob(job: Job): Promise<void> {
  const ws = job.workspace;
  const wait = await takeToken(ws);
  if (wait > 0) return release(job, wait, null, false);

  const r = await sendMessage(ws, { to: job.contact, text: job.text, client_ref: job.client_ref! });
  const messages = await col.messages();
  switch (r.kind) {
    case 'accepted':
      await messages.updateOne(
        { _id: job._id },
        { $set: { send_state: 'done', lease_owner: null, lease_until: null, last_error: null, ...(r.id ? { pigeon_id: r.id } : {}) }, $inc: { attempts: 1 } },
      );
      return;
    case 'rate_limited':
      await startCoolOff(ws, r.retryAfterMs);
      return release(job, r.retryAfterMs + 250, '429', true);
    case 'unavailable':
      await tripBreaker(ws, BREAKER_MS);
      return release(job, backoff(job.attempts ?? 0), `${r.status}`, true);
    case 'timeout':
      // Possibly accepted. Retrying with the same Idempotency-Key is safe.
      return release(job, 300, 'timeout', true);
    case 'network':
      return release(job, backoff(job.attempts ?? 0), r.error, true);
    case 'rejected': {
      const res = await messages.updateOne(
        { _id: job._id, send_state: 'inflight', lease_owner: instanceId, status_rank: { $lt: 2 } },
        { $set: { send_state: 'dead', status: 'failed', status_rank: 2, lease_owner: null, lease_until: null, last_error: `${r.status} ${r.body}` } },
      );
      if (res.modifiedCount) await emit(ws, `st:${job.client_ref}:failed`, { type: 'message.status', contact: job.contact, client_ref: job.client_ref, status: 'failed', message_id: null });
      return;
    }
  }
}

async function pump(): Promise<void> {
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  try {
    do {
      again = false;
      while (active < MAX_CONCURRENT) {
        const job = await claimNext();
        if (!job) break;
        active++;
        processJob(job)
          .catch((e) => console.error('[outbox] job failed', job.client_ref, e))
          .finally(() => {
            active--;
            void pump();
          });
      }
    } while (again);
  } catch (e) {
    console.error('[outbox] pump error', e);
  } finally {
    pumping = false;
  }
}

export async function startDispatcher(): Promise<void> {
  const sub = getSubscriber();
  await sub.subscribe(keys.outboxWake);
  sub.on('message', (channel) => {
    if (channel === keys.outboxWake) void pump();
  });
  timer = setInterval(() => void pump(), POLL_MS);
  timer.unref();
  console.log(`[outbox] dispatcher ${instanceId} started (pigeon ${config.pigeon.url})`);
}
