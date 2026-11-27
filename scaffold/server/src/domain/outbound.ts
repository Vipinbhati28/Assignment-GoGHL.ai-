import { col, isDupKey } from '../db.js';
import { getRedis, keys } from '../redis.js';
import { emit } from '../realtime/events.js';
import { touchConversation } from './conversations.js';

export interface ReplyInput {
  workspace: string;
  contact: string;
  text: string;
  client_ref: string;
  author?: string | null;
}

/**
 * Durably queues a reply. Returns once it is journaled in MongoDB; the
 * dispatcher sends it. The unique (workspace, client_ref) index makes the
 * same client_ref asked twice — even at the same instant — one reply.
 */
export async function enqueueReply(input: ReplyInput): Promise<{ created: boolean }> {
  const now = new Date();
  const messages = await col.messages();
  let created = true;
  try {
    await messages.insertOne({
      workspace: input.workspace,
      contact: input.contact,
      direction: 'out',
      pigeon_id: null,
      client_ref: input.client_ref,
      text: input.text,
      occurred_at: now,
      created_at: now,
      author: input.author ?? null,
      status: 'queued',
      status_rank: 0,
      send_state: 'pending',
      attempts: 0,
      next_attempt_at: now,
      lease_owner: null,
      lease_until: null,
      last_error: null,
    });
  } catch (e) {
    if (!isDupKey(e)) throw e;
    created = false;
  }
  // Repeated on a duplicate too, so a crash between steps is repaired by the retry.
  await touchConversation(input.workspace, input.contact, now);
  await emit(input.workspace, `out:${input.client_ref}`, { type: 'message.outbound', contact: input.contact, client_ref: input.client_ref, text: input.text, status: 'queued' });
  if (created) getRedis().publish(keys.outboxWake, input.workspace).catch(() => {});
  return { created };
}
