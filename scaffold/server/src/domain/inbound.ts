import { col, isDupKey } from '../db.js';
import { emit } from '../realtime/events.js';
import { touchConversation } from './conversations.js';

export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

export class BadEvent extends Error {}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;

/**
 * Stores a customer message. Idempotent: the unique (workspace, pigeon_id)
 * index makes a redelivery a no-op. Every step is safe to repeat, so a
 * retry after a crash between steps completes the work without duplicates.
 */
export async function recordInbound(workspace: string, data: Record<string, unknown>, occurredAtRaw: unknown): Promise<void> {
  const { message_id, from, text } = data;
  const occurredAt = new Date(String(occurredAtRaw));
  if (!str(message_id) || !str(from) || typeof text !== 'string' || Number.isNaN(occurredAt.getTime())) {
    throw new BadEvent('message.inbound needs data.message_id, data.from, data.text and occurred_at');
  }
  const messages = await col.messages();
  try {
    await messages.updateOne(
      { workspace, direction: 'in', pigeon_id: message_id },
      {
        $setOnInsert: { workspace, contact: from, direction: 'in', pigeon_id: message_id, client_ref: null, text, occurred_at: occurredAt, created_at: new Date() },
      },
      { upsert: true },
    );
  } catch (e) {
    if (!isDupKey(e)) throw e; // a concurrent duplicate won the insert
  }
  await touchConversation(workspace, from, occurredAt, true);
  await emit(workspace, `in:${message_id}`, { type: 'message.inbound', contact: from, message_id, text, occurred_at: occurredAt.toISOString() });
}

/**
 * Applies a delivery status. Status only moves forward (queued < sent <
 * delivered|failed), so out-of-order and duplicate webhooks are harmless.
 * A status for a client_ref we never sent matches nothing and is ignored.
 */
export async function applyStatus(workspace: string, data: Record<string, unknown>): Promise<void> {
  const { client_ref, status, message_id } = data;
  if (!str(client_ref) || !str(status)) throw new BadEvent('message.status needs data.client_ref and data.status');
  const rank = STATUS_RANK[status];
  if (rank === undefined) return; // a status we don't know: acknowledge, ignore
  const messages = await col.messages();
  const set: Record<string, unknown> = { status, status_rank: rank };
  if (str(message_id)) set.pigeon_id = message_id;
  const updated = await messages.findOneAndUpdate(
    { workspace, direction: 'out', client_ref, status_rank: { $lt: rank } },
    { $set: set },
    { returnDocument: 'after', projection: { contact: 1 } },
  );
  // Pigeon has the message, so the send is done even if our HTTP call timed out.
  await messages.updateOne({ workspace, direction: 'out', client_ref, send_state: { $in: ['pending', 'inflight'] } }, { $set: { send_state: 'done', lease_owner: null, lease_until: null } });
  if (updated) {
    await emit(workspace, `st:${client_ref}:${status}`, { type: 'message.status', contact: updated.contact, client_ref, status, message_id: str(message_id) ? message_id : null });
  }
}
