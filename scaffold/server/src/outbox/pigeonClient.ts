import { config } from '../config.js';

export type SendResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'unavailable'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network'; error: string }
  | { kind: 'rejected'; status: number; body: string };

// Pigeon sometimes accepts and then answers after 12 s. We give up well before
// that; the retry reuses the Idempotency-Key, which Pigeon records before its
// slow response, so the retry gets the original answer and nothing is sent twice.
const TIMEOUT_MS = 4000;

function parseRetryAfter(v: string | null): number {
  if (!v) return 2000;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 2000 : Math.max(0, at - Date.now());
}

export async function sendMessage(workspace: string, msg: { to: string; text: string; client_ref: string }): Promise<SendResult> {
  const key = config.pigeon.apiKeys[workspace];
  if (!key) return { kind: 'rejected', status: 0, body: 'unknown workspace' };
  let res: Response;
  try {
    res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': msg.client_ref,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'network', error: String((e as Error).message) };
  }
  const body = await res.text().catch(() => '');
  if (res.status >= 200 && res.status < 300) {
    try {
      return { kind: 'accepted', id: String(JSON.parse(body).id ?? '') };
    } catch {
      return { kind: 'accepted', id: '' };
    }
  }
  if (res.status === 429) return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  if (res.status >= 500) return { kind: 'unavailable', status: res.status };
  return { kind: 'rejected', status: res.status, body: body.slice(0, 200) };
}
