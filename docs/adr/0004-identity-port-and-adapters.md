# ADR-0004 Identity port and adapters

Status: accepted · 2026-10-09 · Applies ND-2. Changes to identity code are a gated class.

## Decision

- One identity port (`apps/api/src/ports/identity.ts`) resolves every request to an `actor` (person, agent token, system) and its authority. All modules authorize through it; no module reads session cookies or tokens itself.
- Adapters:
  - `local-owner` (release one, development and standalone): every request is the single owner actor. Only for local and single-user standalone deployments; refused when `WEB_BASE_URL` is not loopback unless `POII_ALLOW_LOCAL_OWNER_REMOTE=true` is set deliberately.
  - `local-signin` (M2): password sign-in for standalone deployments. Better Auth is evaluated first against the requirements below; if it fails, another vetted open-source option is used and this ADR is amended.
  - `accesslobby-oidc` (M3): Authorization Code + PKCE S256 with `state` and `nonce`, discovery and JWKS validation, `GET /v1/me` resolution, storage of `(issuer, sub, person.id, local actor id)` with unique constraints, "this app only" and "all connected apps" sign-out with a verified backchannel logout endpoint. Built to the AccessLobby consumer contract v0.1.
- Account linking is explicit: an existing local actor connects AccessLobby by proving both accounts in one session. No email merge. No automatic fallback to local sign-in during an AccessLobby outage; detach/reattach is a documented, deliberate operation.
- Owner tokens (M2): scoped (`read`, `propose`), expiring, revocable, hashed at rest, tied to the owner. A token actor can read context and create candidates; it can never create an approval, confirm a record, delete or change policy. Revocation is checked on every request.

## Requirements for the local sign-in evaluation

Server-side sessions in PostgreSQL, password hashing with a modern KDF, no email-based account merging, CSRF protection for form posts, revocation of all sessions, and no vendor hosting dependency.

## Consequences

Authorization decisions have one code path and one test suite covering every interface (web, API, later MCP).
