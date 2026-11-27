import { Router } from 'express';
import { config, knownWorkspace } from '../config.js';
import { col } from '../db.js';
import { claimConversation } from '../domain/conversations.js';
import { enqueueReply } from '../domain/outbound.js';
import { getRedis, resettablePatterns } from '../redis.js';
import { requireGraderToken, wrap } from './middleware.js';

// Same domain functions the UI routes call; only the auth differs.
export const grader = Router();
grader.use('/__grader', requireGraderToken);

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

grader.post(
  '/__grader/reset',
  wrap(async (_req, res) => {
    // deleteMany, not drop: indexes must stay for instances already running.
    await Promise.all([(await col.messages()).deleteMany({}), (await col.conversations()).deleteMany({}), (await col.events()).deleteMany({})]);
    const redis = getRedis();
    for (const pattern of resettablePatterns) {
      let cursor = '0';
      do {
        const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (found.length) await redis.del(...found);
      } while (cursor !== '0');
    }
    res.json({ ok: true });
  }),
);

grader.get(
  '/__grader/snapshot',
  wrap(async (_req, res) => {
    const workspaces: Record<string, { contacts: Record<string, { inbound: string[]; assignee: string | null }>; outbound: Record<string, string> }> = {};
    for (const ws of Object.keys(config.pigeon.apiKeys)) workspaces[ws] = { contacts: {}, outbound: {} };
    const contact = (ws: string, c: string) => (workspaces[ws]!.contacts[c] ??= { inbound: [], assignee: null });

    for (const conv of await (await col.conversations()).find({}).toArray()) {
      if (workspaces[conv.workspace]) contact(conv.workspace, conv.contact).assignee = conv.assignee;
    }
    const messages = await col.messages();
    // Same order the UI shows: occurred_at, then message id.
    const inbound = messages.find({ direction: 'in' }, { projection: { workspace: 1, contact: 1, pigeon_id: 1 } }).sort({ workspace: 1, contact: 1, occurred_at: 1, pigeon_id: 1 });
    for await (const m of inbound) if (workspaces[m.workspace]) contact(m.workspace, m.contact).inbound.push(m.pigeon_id!);
    for await (const m of messages.find({ direction: 'out' }, { projection: { workspace: 1, client_ref: 1, status: 1 } })) {
      if (workspaces[m.workspace]) workspaces[m.workspace]!.outbound[m.client_ref!] = m.status ?? 'queued';
    }
    res.json({ workspaces });
  }),
);

grader.post(
  '/__grader/reply',
  wrap(async (req, res) => {
    const { workspace, contact, text, client_ref } = req.body ?? {};
    if (!knownWorkspace(workspace)) return res.status(404).json({ error: 'unknown workspace' });
    if (!str(contact, 64) || !str(text, 4000) || !str(client_ref)) return res.status(400).json({ error: 'contact, text and client_ref are required' });
    await enqueueReply({ workspace, contact, text, client_ref, author: 'grader' });
    res.status(202).json({ client_ref, status: 'queued' });
  }),
);

grader.post(
  '/__grader/claim',
  wrap(async (req, res) => {
    const { workspace, contact, agent } = req.body ?? {};
    if (!knownWorkspace(workspace)) return res.status(404).json({ error: 'unknown workspace' });
    if (!str(contact, 64) || !str(agent)) return res.status(400).json({ error: 'contact and agent are required' });
    const r = await claimConversation(workspace, contact, agent);
    res.status(r === 'conflict' ? 409 : 200).json({ result: r });
  }),
);
