import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;
let subscriber: Redis | undefined;

// Commands and PUBLISH. Connects on first use.
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on('error', (e) => console.error('[redis]', e.message));
  }
  return redis;
}

// A connection in subscribe mode cannot run other commands, so it gets its own.
export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    subscriber.on('error', (e) => console.error('[redis:sub]', e.message));
  }
  return subscriber;
}

export const keys = {
  bucket: (ws: string) => `rl:${ws}`,
  coolOff: (ws: string) => `cool:${ws}`,
  breaker: (ws: string) => `brk:${ws}`,
  seq: (ws: string) => `seq:${ws}`,
  session: (id: string) => `sess:${id}`,
  oidc: (state: string) => `oidc:${state}`,
  eventsChannel: (ws: string) => `events:${ws}`,
  eventsPattern: 'events:*',
  outboxWake: 'outbox:wake',
};

// Application data in Redis; sessions and in-progress logins are kept on reset.
export const resettablePatterns = ['rl:*', 'cool:*', 'brk:*', 'seq:*'];
