import { MongoClient, MongoServerError, type Collection, type Db, type ObjectId } from 'mongodb';
import { config } from './config.js';

export type Direction = 'in' | 'out';
export type SendState = 'pending' | 'inflight' | 'done' | 'dead';

export interface MessageDoc {
  _id?: ObjectId;
  workspace: string;
  contact: string;
  direction: Direction;
  pigeon_id: string | null;
  client_ref: string | null;
  text: string;
  occurred_at: Date;
  created_at: Date;
  author?: string | null;
  // outbound only
  status?: string;
  status_rank?: number;
  send_state?: SendState;
  attempts?: number;
  next_attempt_at?: Date;
  lease_owner?: string | null;
  lease_until?: Date | null;
  last_error?: string | null;
}

export interface ConversationDoc {
  _id?: ObjectId;
  workspace: string;
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  last_activity_at: Date;
  created_at: Date;
}

export interface EventDoc {
  _id?: ObjectId;
  workspace: string;
  seq: number;
  key: string;
  frame: Record<string, unknown>;
  created_at: Date;
}

let client: MongoClient | undefined;

// Connects on first use. Writes are journaled so a 2xx/202 means "survives kill -9".
export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl, { writeConcern: { w: 1, journal: true } });
    await client.connect();
  }
  return client.db();
}

export const col = {
  messages: async (): Promise<Collection<MessageDoc>> => (await getDb()).collection<MessageDoc>('messages'),
  conversations: async (): Promise<Collection<ConversationDoc>> => (await getDb()).collection<ConversationDoc>('conversations'),
  events: async (): Promise<Collection<EventDoc>> => (await getDb()).collection<EventDoc>('ws_events'),
};

export const isDupKey = (e: unknown): e is MongoServerError => e instanceof MongoServerError && e.code === 11000;

// Must finish before /healthz answers 200: every idempotency guarantee rests on these.
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  await db.command({ ping: 1 });
  const messages = await col.messages();
  await messages.createIndexes([
    { key: { workspace: 1, pigeon_id: 1 }, name: 'uniq_inbound', unique: true, partialFilterExpression: { direction: 'in' } },
    { key: { workspace: 1, client_ref: 1 }, name: 'uniq_outbound', unique: true, partialFilterExpression: { direction: 'out' } },
    { key: { workspace: 1, contact: 1, occurred_at: 1, pigeon_id: 1 }, name: 'thread' },
    { key: { send_state: 1, next_attempt_at: 1 }, name: 'outbox_pending' },
    { key: { send_state: 1, lease_until: 1 }, name: 'outbox_lease' },
  ]);
  const conversations = await col.conversations();
  await conversations.createIndexes([
    { key: { workspace: 1, contact: 1 }, name: 'uniq_conversation', unique: true },
    { key: { workspace: 1, last_activity_at: -1, _id: -1 }, name: 'inbox' },
  ]);
  const events = await col.events();
  await events.createIndexes([
    { key: { workspace: 1, seq: 1 }, name: 'uniq_seq', unique: true },
    { key: { workspace: 1, key: 1 }, name: 'uniq_event_key', unique: true },
    { key: { created_at: 1 }, name: 'ttl', expireAfterSeconds: 24 * 3600 },
  ]);
}
