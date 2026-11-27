import express, { Router } from 'express';
import { config, knownWorkspace } from '../config.js';
import { applyStatus, BadEvent, recordInbound } from '../domain/inbound.js';
import { verifyPigeonSignature } from '../security/signature.js';

export const webhooks = Router();

// Raw body on this route only: the HMAC covers the exact bytes Pigeon sent.
webhooks.post('/webhooks/pigeon', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // 1. Authenticity. Pure CPU, cannot throw into a 5xx.
  const sig = verifyPigeonSignature(req.header('x-pigeon-signature'), raw, config.pigeon.webhookSecret);
  if (!sig.ok) return res.status(401).json({ error: `signature ${sig.reason}` });

  // 2. Parse. A genuine but unreadable body is 400, never 5xx.
  let event: { type?: unknown; workspace?: unknown; occurred_at?: unknown; data?: unknown };
  try {
    event = JSON.parse(raw.toString('utf8'));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('not an object');
  } catch {
    return res.status(400).json({ error: 'body is not valid JSON' });
  }

  // 3. Things we acknowledge and ignore, so Pigeon stops retrying.
  if (!knownWorkspace(event.workspace)) return res.status(200).json({ ok: true, ignored: 'unknown workspace' });
  if (event.type !== 'message.inbound' && event.type !== 'message.status') return res.status(200).json({ ok: true, ignored: 'unknown type' });
  const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null;
  if (!data) return res.status(400).json({ error: 'data is missing' });

  // 4. Store, then acknowledge. A 2xx only ever follows a journaled write;
  // a storage failure is a 503 so Pigeon retries.
  try {
    if (event.type === 'message.inbound') await recordInbound(event.workspace, data, event.occurred_at);
    else await applyStatus(event.workspace, data);
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (e instanceof BadEvent) return res.status(400).json({ error: e.message });
    console.error('[webhook] storage failed', e);
    return res.status(503).json({ error: 'try again' });
  }
});
