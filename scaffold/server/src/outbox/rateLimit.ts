import { getRedis, keys } from '../redis.js';

// Pigeon: bucket of 8, refills 4/s, per workspace. We stay a little under it
// so clock skew between us and Pigeon never costs a 429.
const CAPACITY = 6;
const RATE_PER_SEC = 3.5;

// Returns 0 if a token was taken, otherwise milliseconds to wait.
// Cool-off (Retry-After) and the outage breaker are checked first, in the same
// atomic step, so no instance can send while either is in force.
const TAKE_TOKEN = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cool = redis.call('PTTL', KEYS[2])
if cool > 0 then return cool end
local brk = redis.call('PTTL', KEYS[3])
if brk > 0 then return brk end
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local h = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(h[1]) or cap
local ts = tonumber(h[2]) or now
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate / 1000)
local wait = 0
if tokens < 1 then
  wait = math.ceil((1 - tokens) * 1000 / rate)
else
  tokens = tokens - 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 60000)
return wait
`;

export async function takeToken(ws: string): Promise<number> {
  const r = getRedis();
  const wait = await r.eval(TAKE_TOKEN, 3, keys.bucket(ws), keys.coolOff(ws), keys.breaker(ws), CAPACITY, RATE_PER_SEC);
  return Number(wait);
}

export async function startCoolOff(ws: string, ms: number): Promise<void> {
  // small margin: Pigeon measures from its own receive time
  await getRedis().set(keys.coolOff(ws), '1', 'PX', Math.max(1, Math.ceil(ms + 250)));
}

export async function tripBreaker(ws: string, ms: number): Promise<void> {
  // NX: concurrent 503s don't keep extending the pause
  await getRedis().set(keys.breaker(ws), '1', 'PX', ms, 'NX');
}
