import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { ok: true; t: number } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' };

/**
 * Verifies `x-pigeon-signature: t=<unix seconds>,v1=<hex>` where v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). Pure function: no I/O, unit-testable.
 * The body MUST be the exact bytes received, never re-serialised JSON.
 */
export function verifyPigeonSignature(header: string | undefined, rawBody: Buffer, secret: string, nowMs = Date.now()): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const matches = v1.some((hex) => {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
    return timingSafeEqual(Buffer.from(hex, 'hex'), expected);
  });
  if (!matches) return { ok: false, reason: 'mismatch' };

  // "more than five minutes from now", in either direction
  const ts = Number(t);
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  return { ok: true, t: ts };
}
