import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { claimConversation, getThread, listConversations, releaseConversation, setConversationState } from '../domain/conversations.js';
import { enqueueReply } from '../domain/outbound.js';
import { requireMember, requireSession, wrap } from './middleware.js';

// Everything here is scoped to one workspace the signed-in user belongs to.
export const api = Router();
api.use('/api/conversations', requireSession, requireMember);

api.get(
  '/api/conversations',
  wrap(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const state = req.query.state === 'open' || req.query.state === 'closed' ? req.query.state : undefined;
    res.json(await listConversations(req.workspace!, limit, cursor, state));
  }),
);

api.get(
  '/api/conversations/:contact',
  wrap(async (req, res) => {
    res.json(await getThread(req.workspace!, req.params.contact));
  }),
);

api.post(
  '/api/conversations/:contact/reply',
  wrap(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 4000) return res.status(400).json({ error: 'text is required (max 4000 chars)' });
    // The browser generates client_ref so a retried request is the same reply.
    const ref = typeof req.body?.client_ref === 'string' && /^[\w.:-]{1,100}$/.test(req.body.client_ref) ? req.body.client_ref : randomUUID();
    await enqueueReply({ workspace: req.workspace!, contact: req.params.contact, text, client_ref: ref, author: req.session!.sub });
    res.status(202).json({ client_ref: ref, status: 'queued' });
  }),
);

api.post(
  '/api/conversations/:contact/claim',
  wrap(async (req, res) => {
    const r = await claimConversation(req.workspace!, req.params.contact, req.session!.sub);
    res.status(r === 'conflict' ? 409 : 200).json({ result: r });
  }),
);

api.post(
  '/api/conversations/:contact/release',
  wrap(async (req, res) => {
    const ok = await releaseConversation(req.workspace!, req.params.contact, req.session!.sub, req.role === 'admin');
    res.status(ok ? 200 : 409).json({ ok });
  }),
);

for (const [path, state] of [['close', 'closed'], ['reopen', 'open']] as const) {
  api.post(
    `/api/conversations/:contact/${path}`,
    wrap(async (req, res) => {
      const ok = await setConversationState(req.workspace!, req.params.contact, state);
      res.status(ok ? 200 : 404).json({ ok, state });
    }),
  );
}
