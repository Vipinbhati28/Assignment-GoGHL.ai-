import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discovery: Promise<Discovery> | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function getDiscovery(): Promise<Discovery> {
  if (!discovery) {
    discovery = fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (!r.ok) throw new Error(`discovery answered ${r.status}`);
        return r.json() as Promise<Discovery>;
      })
      .catch((e) => {
        discovery = undefined; // retry on next login instead of caching the failure
        throw e;
      });
  }
  return discovery;
}

// jose refetches the key set when it sees an unknown `kid`; the IdP makes a
// new key every time it restarts. A short cooldown lets that happen quickly.
async function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri), { cooldownDuration: 5_000, timeoutDuration: 5_000 });
  return jwks;
}

const b64url = (b: Buffer) => b.toString('base64url');

export interface LoginStart {
  url: string;
  state: string;
  verifier: string;
  nonce: string;
}

export async function startLogin(): Promise<LoginStart> {
  const d = await getDiscovery();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  }).toString();
  return { url: u.toString(), state, verifier, nonce };
}

export interface Identity {
  sub: string;
  name: string | null;
  email: string | null;
  workspaces: Array<{ id: string; role: 'admin' | 'agent' }>;
}

export async function finishLogin(code: string, verifier: string, nonce: string): Promise<Identity> {
  const d = await getDiscovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      code_verifier: verifier,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('no id_token in token response');

  const { payload } = await jwtVerify(tokens.id_token, await getJwks(), {
    issuer: d.issuer,
    audience: config.oidc.clientId,
    algorithms: ['RS256'],
  });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  return toIdentity(payload);
}

function toIdentity(p: JWTPayload): Identity {
  if (typeof p.sub !== 'string') throw new Error('id_token has no sub');
  const raw = Array.isArray(p.workspaces) ? p.workspaces : [];
  const workspaces = raw
    .filter((w): w is { id: string; role: string } => !!w && typeof w.id === 'string' && (w.role === 'admin' || w.role === 'agent'))
    .map((w) => ({ id: w.id, role: w.role as 'admin' | 'agent' }));
  return {
    sub: p.sub,
    name: typeof p.name === 'string' ? p.name : null,
    email: typeof p.email === 'string' ? p.email : null,
    workspaces,
  };
}
