# AccessLobby client registration request for POII

Prepared by the agent for issue #17 (ADR-0012). **This is a request, not a change.** Registering POII changes another peer: the owner reviews it and applies it in AccessLobby through AccessLobby's own process (its `docs/consumer-onboarding.md`, consumer contract v0.1). The agent never changes AccessLobby, its realm or its configuration.

Replace `<staging host>` and `<production host>` with the exact public HTTPS hostnames of the POII **web** app (the value of `WEB_BASE_URL`). Every URL below is on the web origin: POII's browser-facing app relays to its API, which is never exposed. Use one client per environment; never reuse a staging registration in production.

## 1. What POII asks AccessLobby to register

| Field | Local development | Staging | Production |
| --- | --- | --- | --- |
| Client ID (unique, lowercase) | `poii-local` | `poii-staging` | `poii` |
| Client name | POII (local) | POII (staging) | POII |
| Client type | public (`publicClient: true`) | public | public |
| Token endpoint auth method | `none` (PKCE only) | `none` | `none` |
| Flow | Authorization Code only (`standardFlowEnabled: true`; implicit, direct access grants and service accounts off) | same | same |
| PKCE | required, `S256` (`pkce.code.challenge.method: S256`) | same | same |
| Redirect URI (exact) | `http://localhost:3000/signin/accesslobby/callback` | `https://<staging host>/signin/accesslobby/callback` | `https://<production host>/signin/accesslobby/callback` |
| Post-logout redirect URI (exact) | `http://localhost:3000/signin/accesslobby/signed-out` | `https://<staging host>/signin/accesslobby/signed-out` | `https://<production host>/signin/accesslobby/signed-out` |
| Back-channel logout URL (same origin) | `http://localhost:3000/signin/accesslobby/backchannel-logout` | `https://<staging host>/signin/accesslobby/backchannel-logout` | `https://<production host>/signin/accesslobby/backchannel-logout` |
| Back-channel logout session required (`sid` in the logout token) | yes (`backchannel.logout.session.required: true`) | yes | yes |
| Web origin | `http://localhost:3000` | `https://<staging host>` | `https://<production host>` |
| Access-token audience mapper | `accesslobby-api` (`oidc-audience-mapper`, access token only) | same | same |
| AccessLobby API admission | client ID in `ALLOWED_CLIENT_IDS`, or an active reviewed first-party registry row | same | same |
| Scopes POII requests | `openid` (no `profile`, no `email`: POII reads only `sub` and `sid`) | same | same |
| Consent | not required (first-party, owner's own app) | same | same |

POII implements and verifies the back-channel logout endpoint (ADR-0012), so the back-channel URL may be registered from the start.

### Claims POII expects

- **ID token** (RS256, signed by a key in the discovery JWKS): `iss` = the issuer exactly, `aud` = the client ID (with `azp` = the client ID when there are several audiences), `sub`, `nonce` (echoed), `iat`, `exp`, `sid` (issuer session; used for `sid`-only logout tokens). Email and profile claims are ignored.
- **Access token** (RS256): `iss`, `aud` containing `accesslobby-api`, `azp` = the client ID, the same `sub` as the ID token, `exp`.
- **Logout token** (RS256): `iss`, `aud` = the client ID, `iat` (at most 5 minutes old), `jti`, `events` with exactly `http://schemas.openid.net/event/backchannel-logout`, `sub` and/or `sid`, no `nonce`.

### Endpoints POII uses

- Discovery: `${OIDC_ISSUER}/.well-known/openid-configuration`. Its `issuer` must equal the configured issuer exactly, and `authorization_endpoint`, `token_endpoint`, `jwks_uri` and `end_session_endpoint` must be on the issuer's origin. `end_session_endpoint` is needed for "Sign out of all connected apps".
- Identity: `GET ${ACCESSLOBBY_API_URL}/v1/me` with `Authorization: Bearer <access token>`, from the POII API server, expecting `{ "contract": "accesslobby.identity.v0.1", "person": { "id", "status": "active" } }`. POII stores `(issuer, sub, person.id)` against the owner's own POII user; it never links by email.
- RP-initiated logout: `end_session_endpoint?id_token_hint=…&client_id=<client>&post_logout_redirect_uri=<registered URI>`.

## 2. Paste-ready inputs for AccessLobby's tooling

AccessLobby's renderer (`infra/scripts/render-client.py`) produces exactly the client above. For staging, for example (an operator runs it in the AccessLobby checkout):

```sh
python3 infra/scripts/render-client.py \
  --client-id poii-staging \
  --redirect-uri https://<staging host>/signin/accesslobby/callback \
  --logout-uri https://<staging host>/signin/accesslobby/signed-out \
  --backchannel-logout-uri https://<staging host>/signin/accesslobby/backchannel-logout \
  --output /tmp/poii-staging-client.json
```

The equivalent non-mutating plan request for `infra/scripts/plan-onboarding.py --request <file>`:

```json
{
  "action": "register-application",
  "issuer": "https://<staging AccessLobby IAM host>/realms/accesslobby-first-party",
  "clientId": "poii-staging",
  "redirectUri": "https://<staging host>/signin/accesslobby/callback",
  "logoutUri": "https://<staging host>/signin/accesslobby/signed-out",
  "backchannelLogoutUri": "https://<staging host>/signin/accesslobby/backchannel-logout"
}
```

The rendered representation should contain: `"publicClient": true`, `"standardFlowEnabled": true`, `"implicitFlowEnabled": false`, `"directAccessGrantsEnabled": false`, `"serviceAccountsEnabled": false`, the one redirect URI, the web origin, `pkce.code.challenge.method: S256`, `post.logout.redirect.uris`, `backchannel.logout.url`, `backchannel.logout.session.required: "true"` and the `accesslobby-api` audience mapper. No secret is generated or needed.

## 3. After AccessLobby has registered the client (owner)

1. Note the exact issuer (AccessLobby's first-party realm, `https://<IAM host>/realms/accesslobby-first-party`), the client ID and the AccessLobby API base URL of that environment.
2. Set on the POII **API** service (not in Git): `POII_ACCESSLOBBY_ISSUER`, `POII_ACCESSLOBBY_CLIENT_ID`, `POII_ACCESSLOBBY_API_URL`. Leave `POII_ACCESSLOBBY_CLIENT_SECRET` unset (public client). `WEB_BASE_URL` must be the same origin as the registered URIs; otherwise set `POII_ACCESSLOBBY_REDIRECT_URI` and `POII_ACCESSLOBBY_POST_LOGOUT_REDIRECT_URI` to the registered values exactly. `POII_IDENTITY_ADAPTER` must be `local-signin`.
3. Restart the API. Sign in with the POII password, open **Account**, choose **Connect AccessLobby** and sign in at AccessLobby. The Account page then shows the connected AccessLobby person ID.
4. Check: sign out ("This app only"), then "Sign in with AccessLobby" lands on POII; "All connected apps" ends at AccessLobby's logout and returns to POII's sign-in page; signing out of AccessLobby elsewhere ends the POII session (back-channel, staging only, see below).

## 4. Limits to know before approving

- **Local back-channel delivery.** AccessLobby's IAM runs in a container; `http://localhost:3000/...` inside it is the container itself, so local back-channel logout normally does not reach POII. Test it on staging.
- **Delivery is best effort.** If POII is down when AccessLobby sends the logout token, POII sessions last until they expire (`POII_SESSION_TTL_HOURS`).
- **One person.** Only the owner can be linked (owner-only mode). POII does not implement AccessLobby's Join (`prompt=create`) or `/v1/application-entry`; registering for the first-party admission extension is a later decision.
- **Rollback.** Unset `POII_ACCESSLOBBY_ISSUER` and restart the API: the AccessLobby endpoints disappear (404), the link row stays and password sign-in is unchanged. Disabling the client in AccessLobby is AccessLobby's own operation.
