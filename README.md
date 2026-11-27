# Switchboard

A shared team inbox. Customers write in through the Pigeon messaging provider;
support agents sign in, see conversations arrive live, claim them, and reply.
Several workspaces share one deployment and never see each other's data.

## Run it from a clean clone

Needs Node 22+ and Docker.

```sh
cp .env.example .env          # optional: defaults already match the local services (Windows: copy .env.example .env)
npm run up                    # MongoDB, Redis, Pigeon, mock IdP (Docker)
npm run scaffold:install      # server + web dependencies
npm run scaffold:server       # API on http://localhost:4000
npm run scaffold:web          # React app on http://localhost:5173, open this one
```

Sign in as any test user (`u_ben` is an agent in `ws_acme`; `u_eli` belongs to
both workspaces). `npm run inbound` makes a customer write in.

## Tests and the check

```sh
npm --prefix scaffold/server test     # unit tests (node:test): webhook signature, status/ordering rules
npm --prefix scaffold/server run build  # typecheck the server
npm --prefix scaffold/web run build     # typecheck + build the web app
npm run check:full                    # levels 1, 2, 3, 5; writes CHECK_REPORT.json
```

Stop your own server before `npm run check`: the check starts its own copies
from `switchboard.json`. Run levels 2 and 3 on Linux, macOS or WSL (see
`DECISIONS.md`).

## Architecture

```
Pigeon ──webhook──▶ /webhooks/pigeon ──▶ MongoDB ──▶ emit(seq) ──▶ Redis pub/sub ──▶ /ws (every instance)
UI / grader ──reply──▶ outbox (MongoDB) ──▶ dispatcher (lease + Redis rate limit) ──▶ Pigeon /v1/messages
```

- **MongoDB is the source of truth** for anything that must survive `kill -9`:
  `messages` (inbound plus the outbound outbox), `conversations`, `ws_events`
  (the replay log). Unique indexes do the deduplication and are created before
  `/healthz` returns 200.
- **Redis holds state that is shared but can be lost:** per-workspace token
  bucket, `Retry-After` cool-off and outage breaker (one Lua script), `seq`
  counters, sessions, PKCE login state, pub/sub.
- Any number of instances can run behind a load balancer. They share no memory.

`scaffold/server/src/`

| Path | Role |
| --- | --- |
| `index.ts` | Boot: indexes → Redis → WebSockets → dispatcher → listen → healthy |
| `security/signature.ts` | HMAC-SHA256 over the raw body, 5-minute window (pure, tested) |
| `http/webhooks.ts` | `POST /webhooks/pigeon`: verify, parse, store, then acknowledge |
| `http/auth.ts`, `auth/` | OIDC code + PKCE login, ID token checked against JWKS, Redis sessions, `/api/me` |
| `http/api.ts` | Inbox, thread, reply, claim/release, close/reopen (member of the workspace only) |
| `http/grader.ts` | `/__grader/*`, calling the same domain functions as the UI |
| `domain/` | Inbound storage, status rules, outbound queueing, conversations and claims |
| `outbox/` | Dispatcher with leases, Pigeon client, rate limiter |
| `realtime/` | `seq` + `ws_events` log, `/ws` with `after=` replay and in-order delivery |

`scaffold/web/src/`: `App.tsx` (session and workspace), `useRealtime.ts`
(socket, reconnect with `after=`), `components/` (SignIn, Header, Inbox,
ThreadView, Composer, StatusBadge).
