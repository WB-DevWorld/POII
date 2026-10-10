// AccessLobby OIDC relying party (ADR-0004, ADR-0012), built to the AccessLobby consumer contract v0.1:
// discovery, the authorization URL (code + PKCE S256, state, nonce), the code exchange, ID-token, access-token
// and logout-token validation against the discovery JWKS, the end-session URL, and `GET /v1/me` for person.id.
// Better Auth builds the authorization URL and the token request (better-auth/oauth2); jose verifies the JWTs.
// The flow, linking and sessions live in the Better Auth plugin (accesslobby-oidc.auth-plugin.ts).
// Nothing here logs or returns a token.
import { authorizationCodeRequest, createAuthorizationURL } from 'better-auth/oauth2';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AccessLobbySettings } from '../config.js';

/** AccessLobby (discovery, token endpoint, JWKS or the identity API) cannot be reached or answered unusably. */
export class AccessLobbyUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`AccessLobby is unavailable: ${reason}`);
  }
}

/** AccessLobby answered, but what it answered must not be accepted. `code` is safe to show; `reason` is for the log. */
export class AccessLobbyRejected extends Error {
  constructor(readonly code: string, readonly reason: string, readonly status: 400 | 403 = 400) {
    super(`AccessLobby response rejected (${code}): ${reason}`);
  }
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface VerifiedIdToken {
  sub: string;
  sid: string | undefined;
}

export interface VerifiedLogoutToken {
  sub: string | undefined;
  sid: string | undefined;
  jti: string;
}

/** OpenID Connect Back-Channel Logout 1.0 event name. */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** The contract's identity response marker for `GET /v1/me`. */
export const IDENTITY_CONTRACT = 'accesslobby.identity.v0.1';
/** Contract v0.1: AccessLobby signs with RS256. Anything else (including `none` and HMAC) is refused. */
const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_S = 5;
/** Logout tokens older than this are refused (with jti replay protection on top). */
export const LOGOUT_TOKEN_MAX_AGE_S = 300;
/** Re-read discovery after this long; JWKS rotation is handled by jose (unknown `kid` triggers a refetch). */
const DISCOVERY_TTL_MS = 10 * 60_000;
const MAX_TOKEN_LENGTH = 16_384;

const isNonEmptyString = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export class AccessLobbyClient {
  private discovered: { doc: Discovery; at: number } | undefined;
  private jwks: { uri: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

  constructor(readonly settings: AccessLobbySettings) {}

  get discoveryUrl(): string {
    return `${this.settings.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  }

  /**
   * The discovery document, validated: the issuer must be exactly the configured one and every endpoint must
   * be on the issuer's origin (contract: "reject mismatched issuer or unexpected endpoint origins").
   * `fresh` always asks AccessLobby (used when a flow starts, so an outage is reported before the redirect).
   */
  async discover(fresh = false): Promise<Discovery> {
    if (!fresh && this.discovered && Date.now() - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered.doc;
    const response = await this.fetch(this.discoveryUrl, { headers: { accept: 'application/json' } }, 'discovery');
    if (!response.ok) throw new AccessLobbyUnavailable(`discovery answered ${response.status}`);
    const doc = (await response.json().catch(() => null)) as Partial<Discovery> | null;
    if (!doc || doc.issuer !== this.settings.issuer) throw new AccessLobbyUnavailable('discovery names a different issuer');
    const origin = new URL(this.settings.issuer).origin;
    const endpoints = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
    for (const key of [...endpoints, 'end_session_endpoint'] as const) {
      const value = doc[key];
      if (value === undefined && key === 'end_session_endpoint') continue;
      let url: URL;
      try {
        url = new URL(String(value));
      } catch {
        throw new AccessLobbyUnavailable(`discovery has no usable ${key}`);
      }
      if (url.origin !== origin) throw new AccessLobbyUnavailable(`discovery ${key} is not on the issuer's origin`);
    }
    const valid = doc as Discovery;
    this.discovered = { doc: valid, at: Date.now() };
    if (this.jwks?.uri !== valid.jwks_uri) {
      this.jwks = {
        uri: valid.jwks_uri,
        keys: createRemoteJWKSet(new URL(valid.jwks_uri), { timeoutDuration: this.settings.httpTimeoutMs, cooldownDuration: 30_000 }),
      };
    }
    return valid;
  }

  /** Authorization Code + PKCE S256 with state and nonce, to the registered redirect URI. */
  async authorizationUrl(input: { state: string; codeVerifier: string; nonce: string; prompt?: 'login' }): Promise<string> {
    const doc = await this.discover(true);
    const url = await createAuthorizationURL({
      id: 'accesslobby',
      options: { clientId: this.settings.clientId, redirectURI: this.settings.redirectUri },
      authorizationEndpoint: doc.authorization_endpoint,
      redirectURI: this.settings.redirectUri,
      state: input.state,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      scopes: this.settings.scopes,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
    return url.toString();
  }

  /** Exchanges the code (with the PKCE verifier) for the ID token and the access token. */
  async exchangeCode(code: string, codeVerifier: string): Promise<{ idToken: string; accessToken: string }> {
    const doc = await this.discover();
    const { body, headers } = await authorizationCodeRequest({
      code,
      codeVerifier,
      redirectURI: this.settings.redirectUri,
      options: { clientId: this.settings.clientId, clientSecret: this.settings.clientSecret, redirectURI: this.settings.redirectUri },
      tokenEndpoint: doc.token_endpoint,
      // Public client: client_id only (token_endpoint_auth_method none). Confidential: HTTP Basic.
      ...(this.settings.clientSecret ? { authentication: 'basic' as const } : {}),
    });
    const response = await this.fetch(doc.token_endpoint, { method: 'POST', headers, body }, 'token endpoint');
    if (response.status >= 500) throw new AccessLobbyUnavailable(`token endpoint answered ${response.status}`);
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new AccessLobbyRejected('CODE_REJECTED', `token endpoint answered ${response.status} ${String(data?.error ?? '')}`.trim());
    if (!data || !isNonEmptyString(data.id_token, MAX_TOKEN_LENGTH) || !isNonEmptyString(data.access_token, MAX_TOKEN_LENGTH)) {
      throw new AccessLobbyRejected('CODE_REJECTED', 'token response lacks an id_token or access_token');
    }
    if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
      throw new AccessLobbyRejected('CODE_REJECTED', 'token_type is not Bearer');
    }
    return { idToken: data.id_token, accessToken: data.access_token };
  }

  /** ID token: signature (JWKS), issuer, audience = client, azp, exp/iat, nonce. */
  async verifyIdToken(idToken: string, nonce: string): Promise<VerifiedIdToken> {
    const payload = await this.verifyJwt(idToken, this.settings.clientId, 'INVALID_ID_TOKEN', { requiredClaims: ['sub', 'iat', 'exp'] });
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.azp !== undefined && payload.azp !== this.settings.clientId) throw new AccessLobbyRejected('INVALID_ID_TOKEN', 'azp is another client');
    if (audiences.length > 1 && payload.azp !== this.settings.clientId) throw new AccessLobbyRejected('INVALID_ID_TOKEN', 'several audiences without azp');
    if (payload.nonce !== nonce) throw new AccessLobbyRejected('INVALID_ID_TOKEN', 'nonce does not match the flow');
    if (!isNonEmptyString(payload.sub, 255)) throw new AccessLobbyRejected('INVALID_ID_TOKEN', 'sub missing');
    const sid = payload.sid === undefined ? undefined : isNonEmptyString(payload.sid, 255) ? payload.sid : null;
    if (sid === null) throw new AccessLobbyRejected('INVALID_ID_TOKEN', 'sid is not a string');
    return { sub: payload.sub, sid };
  }

  /** Access token: signature, issuer, `aud` = the AccessLobby API, `azp` = this client, same `sub` as the ID token. */
  async verifyAccessToken(accessToken: string, sub: string): Promise<void> {
    const payload = await this.verifyJwt(accessToken, this.settings.apiAudience, 'INVALID_ACCESS_TOKEN', { requiredClaims: ['sub', 'exp'] });
    if (payload.azp !== this.settings.clientId) throw new AccessLobbyRejected('INVALID_ACCESS_TOKEN', 'azp is not this client');
    if (payload.sub !== sub) throw new AccessLobbyRejected('INVALID_ACCESS_TOKEN', 'sub differs from the ID token');
  }

  /** `GET /v1/me` with the access token: the durable AccessLobby person ID. */
  async resolvePerson(accessToken: string): Promise<{ id: string }> {
    const response = await this.fetch(`${this.settings.apiUrl}/v1/me`, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    }, 'identity API');
    if (response.status === 401) throw new AccessLobbyRejected('ACCESSLOBBY_TOKEN_REJECTED', '/v1/me answered 401');
    if (response.status === 403) throw new AccessLobbyRejected('PERSON_SUSPENDED', '/v1/me answered 403', 403);
    if (!response.ok) throw new AccessLobbyUnavailable(`/v1/me answered ${response.status}`);
    const body = (await response.json().catch(() => null)) as { contract?: unknown; person?: { id?: unknown; status?: unknown } } | null;
    if (body?.contract !== IDENTITY_CONTRACT || !isNonEmptyString(body.person?.id, 200)) {
      throw new AccessLobbyUnavailable('/v1/me answered outside contract v0.1');
    }
    if (body.person.status !== 'active') throw new AccessLobbyRejected('PERSON_SUSPENDED', 'person is not active', 403);
    return { id: body.person.id };
  }

  /**
   * Logout token (OpenID Connect Back-Channel Logout 1.0, contract v0.1): signature, issuer, audience = client,
   * at most five minutes old, exactly the back-channel logout event, a jti, `sub` and/or `sid`, and no nonce.
   */
  async verifyLogoutToken(token: string): Promise<VerifiedLogoutToken> {
    const payload = await this.verifyJwt(token, this.settings.clientId, 'INVALID_LOGOUT_TOKEN', {
      requiredClaims: ['iat', 'jti'], maxTokenAge: LOGOUT_TOKEN_MAX_AGE_S,
    });
    const events = payload.events as Record<string, unknown> | undefined;
    const event = events && typeof events === 'object' && !Array.isArray(events) ? events[BACKCHANNEL_LOGOUT_EVENT] : undefined;
    const fail = (reason: string) => new AccessLobbyRejected('INVALID_LOGOUT_TOKEN', reason);
    if (!events || Object.keys(events).length !== 1 || !event || typeof event !== 'object') throw fail('events claim is not the back-channel logout event');
    if ('nonce' in payload) throw fail('a logout token must not carry a nonce');
    if (!isNonEmptyString(payload.jti, 255) || typeof payload.iat !== 'number') throw fail('jti or iat missing');
    const sub = payload.sub === undefined ? undefined : isNonEmptyString(payload.sub, 255) ? payload.sub : null;
    const sid = payload.sid === undefined ? undefined : isNonEmptyString(payload.sid, 255) ? payload.sid : null;
    if (sub === null || sid === null || (!sub && !sid)) throw fail('sub and sid missing or malformed');
    return { sub, sid, jti: payload.jti };
  }

  /** RP-initiated logout at AccessLobby: id_token_hint (when POII has one), client_id and the registered post-logout URI. */
  async endSessionUrl(idTokenHint: string | undefined): Promise<string | null> {
    // Fresh: when AccessLobby is down the browser is not sent there; the caller reports it instead.
    const doc = await this.discover(true);
    if (!doc.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.settings.postLogoutRedirectUri);
    return url.toString();
  }

  private async verifyJwt(
    token: string, audience: string, code: string, options: { requiredClaims: string[]; maxTokenAge?: number },
  ): Promise<JWTPayload> {
    if (!isNonEmptyString(token, MAX_TOKEN_LENGTH)) throw new AccessLobbyRejected(code, 'token missing or too long');
    await this.discover();
    try {
      const { payload } = await jwtVerify(token, this.jwks!.keys, {
        issuer: this.settings.issuer,
        audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: options.requiredClaims,
        ...(options.maxTokenAge !== undefined ? { maxTokenAge: options.maxTokenAge } : {}),
      });
      return payload;
    } catch (error) {
      const name = (error as { code?: string }).code ?? '';
      // The key set could not be fetched: an outage, not a bad token.
      if (name === 'ERR_JWKS_TIMEOUT' || (error instanceof Error && /fetch failed|ECONNREFUSED|socket|Expected 200 OK/i.test(error.message))) {
        throw new AccessLobbyUnavailable('JWKS could not be fetched');
      }
      throw new AccessLobbyRejected(code, name || (error instanceof Error ? error.message : 'invalid JWT'));
    }
  }

  /** Server-side fetch with a timeout that never follows redirects (SSRF, endpoint pinning). */
  private async fetch(url: string, init: RequestInit, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.settings.httpTimeoutMs) });
    } catch {
      throw new AccessLobbyUnavailable(`${what} could not be reached`);
    }
    if (response.status >= 300 && response.status < 400) throw new AccessLobbyUnavailable(`${what} answered with a redirect`);
    return response;
  }
}
