# ADR-0009 Local sign-in and owner tokens

Status: accepted · 2026-10-10 (revised the same day: Better Auth adopted) · Implements the `local-signin` adapter and owner tokens of ADR-0004 (ND-2). Identity, session and token code are gated classes.

## Context

ADR-0004 asks for password sign-in for standalone deployments, with Better Auth evaluated first against six requirements: server-side sessions in PostgreSQL, a modern KDF, no email-based account merging, CSRF protection for form posts, revocation of all sessions, and no vendor hosting dependency. Only if it fails is another vetted open-source option used. It also asks for scoped, expiring, revocable owner tokens that read and propose but never confirm. The solution must fit NestJS 12 + Drizzle + Next.js 16 behind the identity port, be maintained, have a licence usable from a public all-rights-reserved repository, and keep the dependency surface reviewable. POII release one has exactly one person who signs in: the owner.

The first version of this ADR evaluated Better Auth, found that it meets the six requirements once configured, and still chose a small in-house implementation on `node:crypto`. That did not follow ND-2, which allows another option only when Better Auth fails the evaluation.

## Evaluation (Better Auth 1.7.7, documentation and npm registry read 2026-10-10)

| Requirement | Better Auth | In-house on `node:crypto` + PostgreSQL |
| --- | --- | --- |
| Server-side sessions in PostgreSQL | Yes (database sessions, 7-day default). The optional cookie cache skips the database check, so revocation is delayed until it expires unless disabled. | Yes: `identity_session` holds the SHA-256 of a 32-byte random cookie secret; every request reads the row. |
| Modern KDF | Yes, scrypt by default (parameters not documented). | scrypt with the OWASP profile N=2^16, r=8, p=2, parameters stored with each hash. |
| No email-based account merging | Account linking is on by default and links on a verified email; must be switched off with `accountLinking.enabled: false`. Email is a required user field, even with the username plugin. | There is no email at all; logins are local names. |
| CSRF for form posts | Yes: Origin check against `trustedOrigins`, SameSite=Lax, Fetch Metadata. | Sec-Fetch-Site and Origin checks plus a required custom header (`x-poii-csrf: 1`) on every cookie-authenticated mutation and on sign-in. |
| Revoke all sessions | Yes (`revokeSessions`). | Yes (`POST /v1/auth/signout-all`; a password change revokes the other sessions). |
| No vendor hosting dependency | Yes; telemetry is off by default. | Yes. |
| Fits NestJS + Drizzle + Next 16 without owning routing or the port | Partly. It mounts its own catch-all handler (`/api/auth/*`) and owns four tables (`user`, `session`, `account`, `verification`) whose user model duplicates POII's `actor`. There is no official NestJS integration. Schema comes from its own generator, not from our hand-written expand-only migrations. | Yes: one adapter behind the existing identity port, three tables in a normal migration, routes under `/v1/auth`. |
| Maintained, licence | Actively released (last publish 2026-09-30), MIT. | Our code; node:crypto is part of Node. |
| Dependency surface | 17 runtime dependencies (including kysely, jose, nanostores, better-call, noble ciphers and hashes, five database adapters, telemetry) and a long peer-dependency list. | None added. |

## Decision

Better Auth is adopted for `local-signin`. The evaluation above found that it meets the six ND-2 requirements, and the owner decided on 2026-10-10:

> "HOLD PR #32. ND-2 says: evaluate Better Auth first; if it fails, use another vetted open-source option. Your own evaluation says it meets the six requirements, so it passes. Rebuild local sign-in on Better Auth (map its user to our actor; username or owner-only mode is fine). No in-house password hashing or session code. Owner tokens can stay as built. Renumber migrations as needed."

The in-house password hashing, session table, session cookie and sign-in limiter are removed. Installed: `better-auth` 1.7.7 (MIT, pinned exactly; the latest stable 1.x on 2026-10-10), with its username plugin and its Drizzle adapter (`@better-auth/drizzle-adapter`, a dependency of `better-auth`).

### What Better Auth owns and what POII keeps

| Better Auth | POII |
| --- | --- |
| Password hashing (its scrypt; `salt:key` hex in `auth_account.password`), verification, minimum (12) and maximum (128) length | Mapping the Better Auth user to the POII owner actor (`auth_user.actor_id`), and re-attaching it after a restore |
| Sessions in PostgreSQL (`auth_session`), the signed session cookie, sign-in, sign-out, revoke-all, change-password | Owner-only mode: at most one sign-in user, no sign-up over HTTP, first-run bootstrap from the environment |
| Origin check against `trustedOrigins` for cookie-carrying requests to `/v1/auth/*` | The CSRF check on POII's own cookie-authenticated mutations (`x-poii-csrf: 1`, Origin, Sec-Fetch-Site) in the adapter's `resolve()` |
| Rate limiting of `/v1/auth/*` | Which client address it limits on (TCP peer, or a declared trusted proxy) |
| | Owner tokens (unchanged, resolved in front of either adapter) |

### Configuration (`apps/api/src/adapters/better-auth.identity.ts`)

- **Mounting.** Better Auth's own handler (`toNodeHandler` from `better-auth/node`) is mounted on the Express instance at `/v1/auth`, before any body parser: the app is created with `bodyParser: false` and `configureHttpApp` registers the handler first, then the JSON and urlencoded parsers. `basePath: '/v1/auth'`; `baseURL` is the API's own origin, `POII_API_BASE_URL` (default `http://localhost:<PORT or 3001>`). There is no Nest auth controller; the `ContextInterceptor` skips `/v1/auth/`. Under `local-owner` nothing is mounted.
- **HTTP surface.** A `hooks.before` middleware applies to HTTP requests only (the router sets `ctx.request`; server-side `auth.api` calls have none, verified in Better Auth's `dist/api/to-auth-endpoints.mjs` and `dist/api/dispatch.mjs`): any `Authorization` header is refused (`403 TOKEN_NOT_ALLOWED`), `/sign-up/*` is refused (`403 SIGN_UP_DISABLED`), and only `/sign-in/username`, `/sign-out`, `/get-session`, `/list-sessions`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`, `/change-password` and `/ok` are served. Every other endpoint Better Auth ships (email sign-in, social sign-in and callbacks, password reset, email verification, change email, update or delete user, account linking, username availability) answers 404. Sign-in while no user exists answers `409 SIGNIN_NOT_CONFIGURED`.
- **Owner-only mode.** `databaseHooks.user.create.before` refuses a second user (`409 OWNER_ONLY`; Better Auth would turn a 403 there into a silent generic sign-up reply) and sets `actorId` to the owner actor. The unique index `auth_user_single_owner` on `((true))` enforces at most one row in the database as well.
- **Username plugin.** The owner signs in with `POII_OWNER_LOGIN` (default `owner`; 3 to 30 letters, digits, `_` or `.`, the plugin's rules; stored in lower case, case-insensitive at sign-in; fixed once the user exists). Better Auth requires an email, so the owner user stores the synthetic address `owner@poii.invalid` (reserved TLD, RFC 2606). It is never used: no email is ever sent, email sign-in answers 404 and email verification is not required.
- **Actor mapping.** Additional user field `actorId` (`auth_user.actor_id`, `input: false`, foreign key to `actor` with `ON DELETE SET NULL`). `resolve()` calls `auth.api.getSession({ headers })` with the request's cookie only, then loads that person actor and its workspace. When the stored actor no longer exists (a restore replaced the bootstrap workspace), the user is re-attached to the current workspace's owner person (audit `identity.credential_reattached`) at the next bootstrap or request. A revoked person gets 401.
- **Bootstrap.** At API start (`main.ts`), and before the first `/v1/auth` request of a process, the adapter ensures the owner workspace and, when no Better Auth user exists and `POII_OWNER_BOOTSTRAP_PASSWORD` (12 to 128 characters) is set, creates the owner server-side with `auth.api.signUpEmail` (username, synthetic email, display name). `emailAndPassword.autoSignIn: false`, so no session is left behind. Audit `identity.owner_password_bootstrapped`. Once a user exists the variable is ignored and a warning (`identity.bootstrap_password_ignored`) asks to remove it. There is no setup endpoint: on a fresh public deployment the first visitor could claim the instance.
- **Secret.** `secret` = `POII_SESSION_SECRET`, required under `local-signin`, at least 32 characters; the API refuses to start otherwise. It signs the session cookie (HMAC); rotating it signs everyone out.
- **Sessions.** `session.expiresIn` = `POII_SESSION_TTL_HOURS` (default 336, two weeks); `disableSessionRefresh: true`, so the lifetime is absolute; cookie cache off (Better Auth's default, set explicitly), so every request reads the session row.
- **Cookies.** `advanced.cookiePrefix: 'poii'`: the session cookie is `poii.session_token`, or `__Secure-poii.session_token` with the `Secure` flag when `advanced.useSecureCookies` is on, which is whenever `WEB_BASE_URL` is not loopback (`isLoopbackUrl`). HttpOnly, SameSite=Lax, Path=/.
- **Origins.** `trustedOrigins` = the origin of `WEB_BASE_URL` only. `advanced.disableOriginCheck: false` and `advanced.disableCSRFCheck: false` are set explicitly, because Better Auth skips its origin check when `NODE_ENV=test`.
- **Account linking.** `account.accountLinking.enabled: false` (ND-2: no email-based merging).
- **Email and password.** `emailAndPassword.enabled: true`, `minPasswordLength: 12`, `maxPasswordLength: 128`, `requireEmailVerification: false`.
- **Rate limiting.** `rateLimit.enabled: true` (Better Auth turns it off outside `NODE_ENV=production`), `storage: 'memory'`. Better Auth's built-in rules apply per client address and path: sign-in and change-password 3 requests per 10 s, every other path 100 per 10 s; a refused request gets `429` with `X-Retry-After`. Better Auth reads the address only from a header (`advanced.ipAddress.ipAddressHeaders`); POII points it at `x-poii-client-ip`, which the mount middleware always overwrites with the TCP peer address or, only when `POII_TRUST_PROXY=true`, the right-most `X-Forwarded-For` entry. A client-sent `X-Forwarded-For` therefore never escapes the limit unless the operator declared the proxy.
- **Telemetry.** `telemetry.enabled: false`. Better Auth would still enable it when `BETTER_AUTH_TELEMETRY` is set, so the API refuses to start under `local-signin` when that variable is truthy.
- **Logging and audit.** Better Auth's logger is routed into the API's JSON log (`event: better_auth`). Sign-in, revoke-all and password changes are audited (`auth.signed_in`, `auth.signed_out_all`, `auth.password_changed`) from a `hooks.after` middleware; sign-out is not (Better Auth does not hand the ended session to the hook).

### Web app

The browser never talks to the API. The sign-in server action posts `{ username, password }` to `/v1/auth/sign-in/username`, copies the signed token from the API's `Set-Cookie` (either cookie name) into the web app's own HttpOnly `poii_session` cookie, and forwards it on every API call under both Better Auth cookie names (the API reads the one its Secure setting uses). Every server-to-API call carries `x-poii-csrf: 1` and `Origin: <WEB_BASE_URL origin>`, so Better Auth's trusted-origin check passes for sign-out (`/v1/auth/sign-out`) and sign-out everywhere (`/v1/auth/revoke-sessions`). `proxy.ts` still refuses cross-site state-changing requests to the web app and redirects to `/signin` on a 401 under `local-signin`; server actions get Next's own Origin/Host check. There is no password-change page; the endpoint is API-only for now.

### Owner tokens (unchanged)

`poii_` + 32 random bytes (base64url), shown once, stored as SHA-256. Each token is its own `agent_token` actor (attribution) tied to the owner. Scopes `read` and `propose` (`propose` implies `read`) are enforced in `authorization.ts`; an agent_token actor without a scopes array has no scopes (fail closed); a token can never confirm, reject, delete, restore, change `aiAllowed`, back up, manage tokens, sign in or manage sessions. Expiry at most 366 days. The token row is read on every request, so revocation and expiry take effect immediately; an `Authorization` header never falls back to the owner. `OwnerTokenIdentity` wraps either adapter; the identity port no longer has sign-in members.

## Consequences

- One expand-only migration, `0004_better_auth_and_owner_tokens`: `auth_user`, `auth_session`, `auth_account`, `auth_verification` (Better Auth's core schema plus the username plugin's `username` and `display_username` and POII's `actor_id`; snake_case columns, TypeScript keys as Better Auth names its fields) and `owner_token`. Indexes 2 and 3 are left for two other open PRs. Dropping `auth_user_single_owner` (for multi-user sign-in) will be a contract migration.
- Sessions and the sign-in user are not part of backups. A restore no longer signs the owner out: sessions belong to the Better Auth user, whose `actor_id` is set null with the replaced actor and re-attached to the restored owner. Tokens still go with the replaced bootstrap workspace.
- Token creation is excluded from Idempotency-Key storage so the secret is never persisted; the decision uses the normalized path (case-insensitive, trailing slashes removed) because Express routes those variants to the same handler.
- A restore is still accepted when the only extra actors in the target install are owner-token actors; they and their tokens are removed with the replaced bootstrap workspace.
- `/v1/auth/*` answers in Better Auth's format (`{ code, message }` errors), not POII's.

### Residual risks

- **Revocation is immediate only while the cookie cache stays off.** Turning it on would let a revoked session live until the cache expires; it is off by configuration and must stay off.
- **Rate-limit counters are per process** and reset on restart; one API process is the release-one deployment. Without `POII_TRUST_PROXY` every browser sign-in reaches the API from the web server's address, so the limit is effectively global: a stranger can hold sign-in at 3 attempts per 10 s for everyone, delaying the owner by up to 10 s per attempt (never longer). With it, the key is only as good as the proxy chain's `X-Forwarded-For`. There is no per-username lockout; 3 attempts per 10 s per address bounds online guessing.
- **Dependency surface now accepted**: `better-auth` and its 17 runtime dependencies (including kysely, jose, nanostores, better-call, noble ciphers and hashes, the five database adapters and the telemetry package) and their updates. Better Auth's scrypt parameters are its own and not configurable through POII. Updates go through Dependabot and `pnpm audit` like any other dependency and are gated (identity).
- The synthetic email `owner@poii.invalid` is stored in `auth_user` and returned in Better Auth's session and sign-in replies; it identifies nobody.

Revisit when a second person signs in, when the API runs as several processes (move the limiter to PostgreSQL with `rateLimit.storage: 'database'`), or when AccessLobby OIDC (M3) lands.
