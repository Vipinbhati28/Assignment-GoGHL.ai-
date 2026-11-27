import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getRedis, keys } from '../redis.js';
import type { Identity } from './oidc.js';

export const SESSION_COOKIE = 'sb_sid';
export const SESSION_TTL_SECONDS = 8 * 3600;
const LOGIN_TTL_SECONDS = 600;

export type Session = Identity & { created_at: string };

// Opaque random id; everything else stays server-side in Redis (shared by all instances).
export async function createSession(identity: Identity): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const session: Session = { ...identity, created_at: new Date().toISOString() };
  await getRedis().set(keys.session(id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await getRedis().del(keys.session(id));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function sessionIdFrom(req: IncomingMessage): string | null {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return id && /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : null;
}

export async function loadSession(req: IncomingMessage): Promise<Session | null> {
  const id = sessionIdFrom(req);
  if (!id) return null;
  const raw = await getRedis().get(keys.session(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function sessionCookie(id: string, maxAge = SESSION_TTL_SECONDS): string {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// PKCE verifier + nonce live in Redis: /auth/login and /auth/callback may hit different instances.
export async function saveLogin(state: string, data: { verifier: string; nonce: string }): Promise<void> {
  await getRedis().set(keys.oidc(state), JSON.stringify(data), 'EX', LOGIN_TTL_SECONDS);
}

export async function takeLogin(state: string): Promise<{ verifier: string; nonce: string } | null> {
  const raw = await getRedis().getdel(keys.oidc(state)); // single use
  return raw ? (JSON.parse(raw) as { verifier: string; nonce: string }) : null;
}

export const roleIn = (s: Session, workspace: string) => s.workspaces.find((w) => w.id === workspace)?.role ?? null;
