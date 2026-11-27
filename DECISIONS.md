# Decisions

## What we built
A multi-tenant shared inbox with these parts:
- **Login:** OIDC authorization code + PKCE (S256). The ID token is checked against the IdP's JWKS, refetched when the `kid` is unknown because the IdP makes a new key on every restart.
- **Webhooks:** HMAC checked over the raw body, timestamps more than 5 minutes off rejected, deduplication by a unique `(workspace, message_id)` index, threads ordered by `occurred_at` then message id.
- **Outbox:** replies are queued in MongoDB. A sender takes each one with a 10 s lease in a single `findOneAndUpdate`, and every send carries `Idempotency-Key` = `client_ref`.
- **Rate limiting:** one Redis Lua script holds the per-workspace token bucket, the `Retry-After` cool-off and a 1 s pause after a 503. It is shared by all instances.
- **Claims:** decided by one conditional document update.
- **Real time:** WebSockets with a `seq` that only goes up, `after=` replay from a `ws_events` log, and Redis pub/sub so every instance sees every event.
- **Also:** a React UI, and `node:test` unit tests for the signature check and the status/ordering rules.

Every 2xx or 202 is sent only after a journaled MongoDB write, and every step can safely run twice. A crash between steps is therefore repaired when Pigeon or the client retries.

## What we cut, and why
Billing (Paybox), Elasticsearch search and end-to-end encrypted notes. Two hours is enough to make one core reliable under duplicates, crashes and several instances, but not enough to also do those well.

## Assumptions where the brief is silent
- Sessions last 8 hours (Redis TTL). `/__grader/reset` clears application data in MongoDB and Redis but keeps sessions and logins in progress.
- The outbox lease is 10 s. That is longer than our 4 s HTTP timeout to Pigeon, and a dead instance's work is picked up well inside the 60 s limit. Pigeon stores the idempotency key before its 12 s slow answer, so retrying right after a timeout never sends twice.
- Our token bucket (6 burst, 3.5/s) is deliberately below Pigeon's (8, 4/s) to allow for clock differences between instances.
- A new inbound message reopens a closed conversation. An admin can release a conversation someone else holds; an agent can release only their own.
- A webhook whose signature is valid but which lacks required fields gets `400`.

## What we know is still wrong or unproven
- **Levels 2 and 3 have not been run yet.** The check stops servers with `process.kill(-pid)`, which does nothing on native Windows (instances kept running after every check), so crash and failover results there would be meaningless. They are designed for (journaled writes before every 2xx, lease reclaim, idempotent sends) but not measured. They need a run on Linux or WSL.
- `ws_events` keeps 24 h. A client that reconnects with an older `after=` silently gets an incomplete replay instead of being told to reload.
- When two instances publish frames out of order, a socket waits up to 300 ms for the missing `seq`, then fills the gap from MongoDB. A frame written to the log after that wait is never sent live; it appears on reload.
- The UI cannot start a conversation with a contact who has never written in. The backend supports it (`/__grader/reply` and the domain layer).
- The session cookie is not `Secure` unless `COOKIE_SECURE=true`, because local development runs over http.
- No integration tests; the end-to-end coverage is the check harness.
