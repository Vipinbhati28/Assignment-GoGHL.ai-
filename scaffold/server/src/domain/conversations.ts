import { ObjectId } from 'mongodb';
import { col, isDupKey, type ConversationDoc } from '../db.js';
import { emit } from '../realtime/events.js';

/** Creates the conversation if needed and bumps its activity time. Safe under races. */
export async function touchConversation(workspace: string, contact: string, at: Date, reopen = false): Promise<void> {
  const conversations = await col.conversations();
  const update = {
    $setOnInsert: { workspace, contact, assignee: null, created_at: new Date(), ...(reopen ? {} : { state: 'open' as const }) },
    $max: { last_activity_at: at },
    ...(reopen ? { $set: { state: 'open' as const } } : {}),
  };
  for (let i = 0; i < 3; i++) {
    try {
      await conversations.updateOne({ workspace, contact }, update, { upsert: true });
      return;
    } catch (e) {
      if (!isDupKey(e)) throw e; // two concurrent upserts: the loser retries as an update
    }
  }
}

export type ClaimResult = 'claimed' | 'held' | 'conflict';

/** One atomic document update decides the winner, across any number of instances. */
export async function claimConversation(workspace: string, contact: string, agent: string): Promise<ClaimResult> {
  await touchConversation(workspace, contact, new Date(0));
  const conversations = await col.conversations();
  const won = await conversations.findOneAndUpdate({ workspace, contact, assignee: null }, { $set: { assignee: agent } }, { returnDocument: 'after' });
  if (won) {
    await emit(workspace, `as:${new ObjectId().toHexString()}`, { type: 'conversation.assigned', contact, assignee: agent });
    return 'claimed';
  }
  const cur = await conversations.findOne({ workspace, contact });
  return cur?.assignee === agent ? 'held' : 'conflict';
}

/** Holder (or an admin) gives the conversation back. */
export async function releaseConversation(workspace: string, contact: string, agent: string, force: boolean): Promise<boolean> {
  const conversations = await col.conversations();
  const filter = force ? { workspace, contact, assignee: { $ne: null } } : { workspace, contact, assignee: agent };
  const r = await conversations.updateOne(filter, { $set: { assignee: null } });
  if (r.modifiedCount) await emit(workspace, `as:${new ObjectId().toHexString()}`, { type: 'conversation.assigned', contact, assignee: null });
  return r.matchedCount > 0;
}

export async function setConversationState(workspace: string, contact: string, state: 'open' | 'closed'): Promise<boolean> {
  const conversations = await col.conversations();
  const r = await conversations.updateOne({ workspace, contact }, { $set: { state } });
  if (r.modifiedCount) await emit(workspace, `st:${new ObjectId().toHexString()}`, { type: 'conversation.state', contact, state });
  return r.matchedCount > 0;
}

export interface InboxPage {
  items: Array<Pick<ConversationDoc, 'contact' | 'assignee' | 'state'> & { last_activity_at: string }>;
  next_cursor: string | null;
}

/** Newest activity first, keyset-paginated on (last_activity_at, _id). */
export async function listConversations(workspace: string, limit: number, cursor?: string, state?: 'open' | 'closed'): Promise<InboxPage> {
  const conversations = await col.conversations();
  const filter: Record<string, unknown> = { workspace };
  if (state) filter.state = state;
  if (cursor) {
    const [ms, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    if (ms && id && ObjectId.isValid(id)) {
      const at = new Date(Number(ms));
      filter.$or = [{ last_activity_at: { $lt: at } }, { last_activity_at: at, _id: { $lt: new ObjectId(id) } }];
    }
  }
  const docs = await conversations.find(filter).sort({ last_activity_at: -1, _id: -1 }).limit(limit + 1).toArray();
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((d) => ({ contact: d.contact, assignee: d.assignee, state: d.state, last_activity_at: d.last_activity_at.toISOString() })),
    next_cursor: docs.length > limit && last ? Buffer.from(`${last.last_activity_at.getTime()}|${last._id!.toHexString()}`).toString('base64url') : null,
  };
}

export async function getThread(workspace: string, contact: string) {
  const messages = await col.messages();
  const docs = await messages.find({ workspace, contact }).sort({ occurred_at: 1, pigeon_id: 1 }).toArray();
  const conv = await (await col.conversations()).findOne({ workspace, contact });
  return {
    contact,
    assignee: conv?.assignee ?? null,
    state: conv?.state ?? 'open',
    messages: docs.map((m) => ({
      direction: m.direction,
      message_id: m.pigeon_id,
      client_ref: m.client_ref,
      text: m.text,
      occurred_at: m.occurred_at.toISOString(),
      status: m.direction === 'out' ? m.status : undefined,
      author: m.author ?? null,
    })),
  };
}
