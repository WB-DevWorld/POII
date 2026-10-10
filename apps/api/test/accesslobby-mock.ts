// MOCKED: a local stand-in for AccessLobby, used only by the AccessLobby OIDC tests. It is not AccessLobby and
// proves nothing about the real service; it implements just enough of the consumer contract v0.1 to exercise
// POII's relying party: OIDC discovery, a JWKS with a freshly generated RSA key, the authorization endpoint
// (code + PKCE S256, state, nonce, exact redirect URI), the token endpoint (verifies the PKCE verifier), an
// end-session endpoint, and `GET /v1/me` (verifies the access token, answers person.id). It also signs logout
// tokens for the back-channel logout tests. Everything lives in memory and listens on 127.0.0.1 only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWTPayload, type CryptoKey } from 'jose';

export const MOCK_API_AUDIENCE = 'accesslobby-api';
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface MockLogin {
  sub: string;
  personId: string;
  /** Present in the ID token; POII must never use it. */
  email?: string;
  sid?: string;
  /** `/v1/me` answers 403 (suspended) for this person. */
  suspended?: boolean;
}

interface PendingCode {
  login: MockLogin;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
}

export interface MockAccessLobby {
  base: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** Whom the next authorization request signs in. */
  nextLogin: MockLogin | undefined;
  /** When true every connection is dropped (AccessLobby unreachable). */
  down: boolean;
  /** When true only `/v1/me` answers 503. */
  identityDown: boolean;
  /** Tamper with the next ID token's claims (e.g. a wrong nonce). */
  idTokenOverrides: Partial<JWTPayload> | undefined;
  /** Query parameters of the last authorization request. */
  lastAuthorize: URLSearchParams | undefined;
  /** ID tokens issued, newest last. */
  issuedIdTokens: string[];
  /** Follows a POII authorization URL like a browser that signs in at once; returns the callback parameters. */
  authorize(url: string): Promise<{ code: string; state: string; iss: string }>;
  /** A logout token signed with the mock's key (or another key), with claim overrides; `undefined` removes a claim. */
  logoutToken(claims: Record<string, unknown>, options?: { foreignKey?: boolean }): Promise<string>;
  close(): Promise<void>;
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startMockAccessLobby(options: { clientId: string; redirectUri: string }): Promise<MockAccessLobby> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const foreign = await generateKeyPair('RS256', { extractable: true });
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  /** The latest login per subject, for `/v1/me`. */
  const logins = new Map<string, MockLogin>();
  let server: Server;

  const sign = (claims: JWTPayload, key: CryptoKey = privateKey, keyId = kid) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' }).sign(key);

  const mock: MockAccessLobby = {
    base: '', issuer: '', clientId: options.clientId, redirectUri: options.redirectUri,
    nextLogin: undefined, down: false, identityDown: false, idTokenOverrides: undefined, lastAuthorize: undefined, issuedIdTokens: [],
    async authorize(url) {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status !== 302) throw new Error(`mock authorize answered ${response.status}: ${await response.text()}`);
      const location = new URL(response.headers.get('location')!);
      return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')!, iss: location.searchParams.get('iss')! };
    },
    async logoutToken(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: mock.issuer, aud: mock.clientId, iat: now, exp: now + 120, jti: randomUUID(),
        events: { [BACKCHANNEL_EVENT]: {} }, ...claims,
      };
      for (const [key, value] of Object.entries(payload)) if (value === undefined) delete payload[key];
      return opts.foreignKey ? sign(payload as JWTPayload, foreign.privateKey) : sign(payload as JWTPayload);
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  };

  server = createServer(async (req, res) => {
    if (mock.down) {
      req.socket.destroy();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', mock.base);
      const realm = '/realms/mock';
      if (req.method === 'GET' && url.pathname === `${realm}/.well-known/openid-configuration`) {
        return json(res, 200, {
          issuer: mock.issuer,
          authorization_endpoint: `${mock.issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${mock.issuer}/protocol/openid-connect/token`,
          jwks_uri: `${mock.issuer}/protocol/openid-connect/certs`,
          end_session_endpoint: `${mock.issuer}/protocol/openid-connect/logout`,
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          backchannel_logout_supported: true,
          backchannel_logout_session_supported: true,
        });
      }
      if (req.method === 'GET' && url.pathname === `${realm}/protocol/openid-connect/certs`) {
        return json(res, 200, { keys: [jwk] });
      }
      if (req.method === 'GET' && url.pathname === `${realm}/protocol/openid-connect/auth`) {
        const q = url.searchParams;
        mock.lastAuthorize = q;
        if (q.get('client_id') !== mock.clientId || q.get('redirect_uri') !== mock.redirectUri) return json(res, 400, { error: 'invalid_request' });
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request' });
        if (!q.get('state') || !q.get('nonce') || !(q.get('scope') ?? '').split(' ').includes('openid')) return json(res, 400, { error: 'invalid_request' });
        if (!mock.nextLogin) return json(res, 400, { error: 'no test login set' });
        const code = randomBytes(24).toString('base64url');
        logins.set(mock.nextLogin.sub, mock.nextLogin);
        codes.set(code, { login: mock.nextLogin, clientId: mock.clientId, redirectUri: q.get('redirect_uri')!, challenge: q.get('code_challenge')!, nonce: q.get('nonce')! });
        const target = new URL(mock.redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', q.get('state')!);
        target.searchParams.set('iss', mock.issuer);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === `${realm}/protocol/openid-connect/token`) {
        const form = new URLSearchParams(await readBody(req));
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!pending || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== pending.clientId
          || form.get('redirect_uri') !== pending.redirectUri || s256(form.get('code_verifier') ?? '') !== pending.challenge) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const { login } = pending;
        const idToken = await sign({
          iss: mock.issuer, aud: mock.clientId, azp: mock.clientId, sub: login.sub, nonce: pending.nonce, iat: now, exp: now + 300,
          ...(login.sid ? { sid: login.sid } : {}), ...(login.email ? { email: login.email, email_verified: true } : {}),
          ...(mock.idTokenOverrides ?? {}),
        });
        mock.idTokenOverrides = undefined;
        mock.issuedIdTokens.push(idToken);
        const accessToken = await sign({ iss: mock.issuer, aud: MOCK_API_AUDIENCE, azp: mock.clientId, sub: login.sub, iat: now, exp: now + 300 });
        return json(res, 200, { token_type: 'Bearer', id_token: idToken, access_token: accessToken, expires_in: 300, scope: 'openid' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/me') {
        if (mock.identityDown) return json(res, 503, { error: 'unavailable' });
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!token) return json(res, 401, { error: 'unauthenticated' });
        let sub: string;
        try {
          const { payload } = await jwtVerify(token, publicKey, { issuer: mock.issuer, audience: MOCK_API_AUDIENCE });
          sub = String(payload.sub);
        } catch {
          return json(res, 401, { error: 'unauthenticated' });
        }
        const login = logins.get(sub);
        if (!login) return json(res, 401, { error: 'unauthenticated' });
        if (login.suspended) return json(res, 403, { error: 'suspended' });
        return json(res, 200, { contract: 'accesslobby.identity.v0.1', person: { id: login.personId, status: 'active' }, requestId: randomUUID() });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      // The mock logs the failure for the test run; the response carries no error text or stack.
      console.error('[mock accesslobby]', error instanceof Error ? error.message : String(error));
      return json(res, 500, { error: 'mock_failure' });
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.issuer = `${mock.base}/realms/mock`;
  return mock;
}
