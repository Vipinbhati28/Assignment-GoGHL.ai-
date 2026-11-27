import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifyPigeonSignature } from '../src/security/signature.js';

const SECRET = 'whsec_pigeon_dev';
const NOW = 1_795_016_513_000; // fixed clock, ms
const body = Buffer.from('{"id":"evt_1","type":"message.inbound","workspace":"ws_acme","data":{"message_id":"pmsg_1"}}');

const sign = (t: number, raw: Buffer, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
const t = Math.floor(NOW / 1000);

test('accepts a valid signature over the raw body', () => {
  assert.deepEqual(verifyPigeonSignature(sign(t, body), body, SECRET, NOW), { ok: true, t });
});

test('accepts a timestamp exactly five minutes old (slow networks exist)', () => {
  assert.equal(verifyPigeonSignature(sign(t - 300, body), body, SECRET, NOW).ok, true);
});

test('rejects a signature made with the wrong secret', () => {
  assert.deepEqual(verifyPigeonSignature(sign(t, body, 'not-the-secret'), body, SECRET, NOW), { ok: false, reason: 'mismatch' });
});

test('rejects a tampered body, even one that is the same JSON re-serialised', () => {
  const header = sign(t, body);
  const tampered = Buffer.from(body.toString().replace('pmsg_1', 'pmsg_2'));
  assert.equal(verifyPigeonSignature(header, tampered, SECRET, NOW).ok, false);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
  assert.equal(verifyPigeonSignature(header, reserialised, SECRET, NOW).ok, false);
});

test('rejects a correctly signed timestamp more than five minutes old', () => {
  assert.deepEqual(verifyPigeonSignature(sign(t - 301, body), body, SECRET, NOW), { ok: false, reason: 'stale' });
  assert.deepEqual(verifyPigeonSignature(sign(t - 3600, body), body, SECRET, NOW), { ok: false, reason: 'stale' });
});

test('rejects a correctly signed timestamp more than five minutes in the future', () => {
  assert.deepEqual(verifyPigeonSignature(sign(t + 301, body), body, SECRET, NOW), { ok: false, reason: 'stale' });
});

test('rejects missing and malformed headers without throwing', () => {
  assert.deepEqual(verifyPigeonSignature(undefined, body, SECRET, NOW), { ok: false, reason: 'missing' });
  for (const h of ['garbage', `t=abc,v1=${'0'.repeat(64)}`, `t=${t}`, `v1=${'0'.repeat(64)}`]) {
    assert.equal(verifyPigeonSignature(h, body, SECRET, NOW).ok, false, h);
  }
  // wrong-length hex must not reach timingSafeEqual (which would throw)
  assert.deepEqual(verifyPigeonSignature(`t=${t},v1=abcd`, body, SECRET, NOW), { ok: false, reason: 'mismatch' });
});
