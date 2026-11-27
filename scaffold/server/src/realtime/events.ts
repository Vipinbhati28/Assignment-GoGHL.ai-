import { col, isDupKey } from '../db.js';
import { getRedis, keys } from '../redis.js';

export type Frame = { seq: number; type: string; [k: string]: unknown };

/**
 * Records one change for a workspace and fans it out to every instance.
 * `key` names the fact (e.g. `in:<message_id>`), so emitting the same fact
 * twice — a duplicate webhook, a retry after a crash — produces one frame.
 */
export async function emit(workspace: string, key: string, frame: Omit<Frame, 'seq'>): Promise<void> {
  const events = await col.events();
  // Cheap pre-check so duplicates don't burn seq numbers (gaps slow live delivery).
  if (await events.findOne({ workspace, key }, { projection: { _id: 1 } })) return;

  const redis = getRedis();
  for (let attempt = 0; attempt < 3; attempt++) {
    const seq = await redis.incr(keys.seq(workspace));
    const full = { ...frame, seq } as Frame;
    try {
      await events.insertOne({ workspace, seq, key, frame: full, created_at: new Date() });
    } catch (e) {
      if (!isDupKey(e)) throw e;
      if ((e.keyPattern ?? {}).key) return; // same fact recorded concurrently
      // seq collision: Redis lost its counter (restart). Resync from Mongo, retry.
      const last = await events.find({ workspace }).sort({ seq: -1 }).limit(1).next();
      if (last) await redis.eval("if tonumber(redis.call('GET', KEYS[1]) or '0') < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end", 1, keys.seq(workspace), last.seq);
      continue;
    }
    await redis.publish(keys.eventsChannel(workspace), JSON.stringify(full));
    return;
  }
}

export async function framesAfter(workspace: string, after: number, upTo?: number): Promise<Frame[]> {
  const events = await col.events();
  const seq: Record<string, number> = { $gt: after };
  if (upTo !== undefined) seq.$lte = upTo;
  const docs = await events.find({ workspace, seq }).sort({ seq: 1 }).limit(5000).toArray();
  return docs.map((d) => d.frame as Frame);
}

export async function currentSeq(workspace: string): Promise<number> {
  return Number((await getRedis().get(keys.seq(workspace))) ?? 0);
}
