export interface Settings {
  databaseUrl: string;
  port: number;
  version: string;
  identityAdapter: 'local-owner' | 'local-signin'; // #14 auth and tokens: local-signin added
  /** ADR-0004: local-owner is refused for a non-loopback WEB_BASE_URL unless this is set deliberately. */
  allowLocalOwnerRemote: boolean;
  ownerDisplayName: string;
  // #14 auth and tokens
  auth: AuthSettings;
  storageAdapter: 'local';
  storageLocalDir: string;
  aiEnabled: boolean;
  webBaseUrl: string;
  ai: AiSettings; // #13 AI
  accesslobby: AccessLobbySettings | null; // #17 AccessLobby OIDC: null unless POII_ACCESSLOBBY_ISSUER is set
}

export function config(env: NodeJS.ProcessEnv = process.env): Settings {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const identityAdapter = env.POII_IDENTITY_ADAPTER ?? 'local-owner';
  if (identityAdapter !== 'local-owner' && identityAdapter !== 'local-signin') throw new Error(`Unsupported POII_IDENTITY_ADAPTER: ${identityAdapter}`);
  const storageAdapter = env.POII_STORAGE_ADAPTER ?? 'local';
  if (storageAdapter !== 'local') throw new Error(`Unsupported POII_STORAGE_ADAPTER: ${storageAdapter}`);
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3001),
    version: env.GIT_SHA ?? 'dev',
    identityAdapter,
    allowLocalOwnerRemote: env.POII_ALLOW_LOCAL_OWNER_REMOTE === 'true',
    ownerDisplayName: env.POII_OWNER_DISPLAY_NAME ?? 'Owner',
    auth: authSettings(env, identityAdapter), // #14 auth and tokens
    storageAdapter,
    storageLocalDir: env.POII_STORAGE_LOCAL_DIR ?? '.poii-storage',
    aiEnabled: env.POII_AI_ENABLED === 'true',
    webBaseUrl: env.WEB_BASE_URL ?? 'http://localhost:3000',
    ai: aiConfig(env), // #13 AI
    accesslobby: accessLobbySettings(env, identityAdapter), // #17 AccessLobby OIDC
  };
}

// #13 AI ----------------------------------------------------------------------------------------------
// AI execution settings (ADR-0007). A provider is available only when POII_AI_ENABLED=true and its key is
// set; otherwise the `off` adapter answers every AI endpoint with 503 ai_disabled. Caps are USD per
// provider per calendar month (UTC), enforced inside POII.
export type AiProviderSetting = 'anthropic' | 'openai';

export interface AiProviderSettings {
  apiKey: string | null;
  model: string;
  monthlyCapUsd: number;
}

export interface AiSettings {
  defaultProvider: AiProviderSetting | null;
  anthropic: AiProviderSettings;
  openai: AiProviderSettings;
  /** Store the prompt text in the audit log (only ever for AI-allowed material). Default false: hash and ids only. */
  logRequestText: boolean;
  previewTtlSeconds: number;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export const AI_DEFAULT_MODELS: Record<AiProviderSetting, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' };

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, integer = true): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${name}: expected ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiSettings {
  const defaultProvider = env.POII_AI_PROVIDER_DEFAULT?.trim() || null;
  if (defaultProvider !== null && defaultProvider !== 'anthropic' && defaultProvider !== 'openai') {
    throw new Error(`Unsupported POII_AI_PROVIDER_DEFAULT: ${defaultProvider}`);
  }
  const key = (name: string) => env[name]?.trim() || null;
  return {
    defaultProvider,
    anthropic: {
      apiKey: key('ANTHROPIC_API_KEY'),
      model: env.POII_AI_ANTHROPIC_MODEL?.trim() || AI_DEFAULT_MODELS.anthropic,
      monthlyCapUsd: numberEnv(env, 'POII_AI_MONTHLY_CAP_USD_ANTHROPIC', 20, 0, 100_000, false),
    },
    openai: {
      apiKey: key('OPENAI_API_KEY'),
      model: env.POII_AI_OPENAI_MODEL?.trim() || AI_DEFAULT_MODELS.openai,
      monthlyCapUsd: numberEnv(env, 'POII_AI_MONTHLY_CAP_USD_OPENAI', 20, 0, 100_000, false),
    },
    logRequestText: env.POII_AI_LOG_REQUEST_TEXT === 'true',
    previewTtlSeconds: numberEnv(env, 'POII_AI_PREVIEW_TTL_SECONDS', 900, 10, 86_400),
    maxInputChars: numberEnv(env, 'POII_AI_MAX_INPUT_CHARS', 100_000, 100, 2_000_000),
    maxOutputTokens: numberEnv(env, 'POII_AI_MAX_OUTPUT_TOKENS', 8_000, 256, 128_000),
    timeoutMs: numberEnv(env, 'POII_AI_TIMEOUT_MS', 600_000, 1_000, 900_000),
  };
}
// end #13 AI ------------------------------------------------------------------------------------------
// #14 auth and tokens (ADR-0009) ------------------------------------------------------------------
export interface AuthSettings {
  /** Username of the single Better Auth user created at first-run bootstrap (local-signin). Fixed once created. */
  ownerLogin: string;
  /** Used only while no sign-in user exists, then ignored with a warning (local-signin). */
  bootstrapPassword: string | undefined;
  /** Absolute lifetime of a sign-in session (Better Auth `session.expiresIn`; refresh is off). */
  sessionTtlHours: number;
  /** Take the client address for Better Auth's rate limiter from X-Forwarded-For (only when the API is reachable solely through a trusted proxy such as the web app). */
  trustProxy: boolean;
  /** Better Auth `secret`: signs the session cookie. Required (at least 32 characters) under local-signin. */
  sessionSecret: string | undefined;
  /** The API's own base URL (Better Auth `baseURL`); Better Auth's endpoints live under `${apiBaseUrl}/v1/auth`. */
  apiBaseUrl: string;
}

export const MIN_PASSWORD_LENGTH = 12;
/** Better Auth's default maximum password length. */
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_SESSION_SECRET_LENGTH = 32;

function authSettings(env: NodeJS.ProcessEnv, identityAdapter: string): AuthSettings {
  const signin = identityAdapter === 'local-signin';
  const ownerLogin = (env.POII_OWNER_LOGIN ?? 'owner').trim();
  // Better Auth's username plugin rules (3 to 30 of letters, digits, `_` and `.`); it stores the login in lower case.
  if (!/^[A-Za-z0-9_.]{3,30}$/.test(ownerLogin)) throw new Error('POII_OWNER_LOGIN must be 3 to 30 letters, digits, _ or .');
  const bootstrapPassword = env.POII_OWNER_BOOTSTRAP_PASSWORD || undefined;
  if (signin && bootstrapPassword !== undefined && (bootstrapPassword.length < MIN_PASSWORD_LENGTH || bootstrapPassword.length > MAX_PASSWORD_LENGTH)) {
    throw new Error(`POII_OWNER_BOOTSTRAP_PASSWORD must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
  }
  // Better Auth also reads this variable and would turn its telemetry on regardless of the configuration.
  if (signin && env.BETTER_AUTH_TELEMETRY && !['0', 'false'].includes(env.BETTER_AUTH_TELEMETRY.toLowerCase())) {
    throw new Error('BETTER_AUTH_TELEMETRY must not be enabled: POII sends no telemetry (ADR-0009)');
  }
  const sessionTtlHours = Number(env.POII_SESSION_TTL_HOURS ?? 336);
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0 || sessionTtlHours > 24 * 90) {
    throw new Error('POII_SESSION_TTL_HOURS must be between 0 and 2160');
  }
  const sessionSecret = env.POII_SESSION_SECRET || undefined;
  if (signin && (sessionSecret === undefined || sessionSecret.length < MIN_SESSION_SECRET_LENGTH)) {
    throw new Error(`POII_SESSION_SECRET is required for local-signin and must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  const apiBaseUrl = env.POII_API_BASE_URL ?? `http://localhost:${env.PORT && env.PORT !== '0' ? env.PORT : 3001}`;
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error('POII_API_BASE_URL must be an absolute http(s) URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('POII_API_BASE_URL must be an http(s) origin without a path, for example http://localhost:3001');
  }
  return { ownerLogin, bootstrapPassword, sessionTtlHours, trustProxy: env.POII_TRUST_PROXY === 'true', sessionSecret, apiBaseUrl: parsed.origin };
}

// #17 AccessLobby OIDC (ADR-0012) -------------------------------------------------------------------
// AccessLobby sign-in and explicit account linking on top of local-signin, built to the AccessLobby consumer
// contract v0.1. Off unless POII_ACCESSLOBBY_ISSUER is set; then the client ID and the AccessLobby API URL are
// required too. The redirect and post-logout URIs live on the web origin (the browser never talks to the API).
export interface AccessLobbySettings {
  /** Exact issuer; discovery is `${issuer}/.well-known/openid-configuration` and must name the same issuer. */
  issuer: string;
  clientId: string;
  /** Confidential client only (client_secret_basic); unset = public client with PKCE (the contract's default profile). */
  clientSecret: string | undefined;
  /** AccessLobby API base URL; POII calls `${apiUrl}/v1/me` with the access token to obtain person.id. */
  apiUrl: string;
  /** Audience the access token must carry (contract: `accesslobby-api`). */
  apiAudience: string;
  /** Registered callback on the web origin. */
  redirectUri: string;
  /** Registered post-logout redirect on the web origin ("all connected apps" sign-out). */
  postLogoutRedirectUri: string;
  /** Requested scopes. POII uses only `sub` and the access token; email is never read (no email merge). */
  scopes: string[];
  /** Timeout for every server-side call to AccessLobby (discovery, token, JWKS, /v1/me). */
  httpTimeoutMs: number;
}

/** Callback, post-logout and backchannel paths on the web origin (registered with AccessLobby). */
export const ACCESSLOBBY_WEB_PATHS = {
  callback: '/signin/accesslobby/callback',
  signedOut: '/signin/accesslobby/signed-out',
  backchannelLogout: '/signin/accesslobby/backchannel-logout',
} as const;

function exactUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use https (plain http only on localhost)`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, a query or a fragment`);
  return value;
}

export function accessLobbySettings(env: NodeJS.ProcessEnv, identityAdapter: string): AccessLobbySettings | null {
  const issuer = env.POII_ACCESSLOBBY_ISSUER?.trim() || undefined;
  const clientId = env.POII_ACCESSLOBBY_CLIENT_ID?.trim() || undefined;
  const apiUrl = env.POII_ACCESSLOBBY_API_URL?.trim() || undefined;
  if (!issuer) {
    if (clientId || apiUrl || env.POII_ACCESSLOBBY_CLIENT_SECRET) throw new Error('POII_ACCESSLOBBY_* is set but POII_ACCESSLOBBY_ISSUER is not');
    return null;
  }
  if (identityAdapter !== 'local-signin') {
    throw new Error('AccessLobby sign-in needs POII_IDENTITY_ADAPTER=local-signin: an AccessLobby identity is linked to the owner from a password session');
  }
  if (!clientId || !/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) throw new Error('POII_ACCESSLOBBY_CLIENT_ID is required (letters, digits, ., _ or -)');
  if (!apiUrl) throw new Error('POII_ACCESSLOBBY_API_URL is required (the AccessLobby API that answers GET /v1/me)');
  const web = (env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return {
    issuer: exactUrl('POII_ACCESSLOBBY_ISSUER', issuer),
    clientId,
    clientSecret: env.POII_ACCESSLOBBY_CLIENT_SECRET || undefined,
    apiUrl: exactUrl('POII_ACCESSLOBBY_API_URL', apiUrl).replace(/\/+$/, ''),
    apiAudience: env.POII_ACCESSLOBBY_API_AUDIENCE?.trim() || 'accesslobby-api',
    redirectUri: exactUrl('POII_ACCESSLOBBY_REDIRECT_URI', env.POII_ACCESSLOBBY_REDIRECT_URI?.trim() || `${web}${ACCESSLOBBY_WEB_PATHS.callback}`),
    postLogoutRedirectUri: exactUrl(
      'POII_ACCESSLOBBY_POST_LOGOUT_REDIRECT_URI',
      env.POII_ACCESSLOBBY_POST_LOGOUT_REDIRECT_URI?.trim() || `${web}${ACCESSLOBBY_WEB_PATHS.signedOut}`,
    ),
    scopes: ['openid'],
    httpTimeoutMs: numberEnv(env, 'POII_ACCESSLOBBY_TIMEOUT_MS', 5_000, 500, 60_000),
  };
}
// end #17 AccessLobby OIDC --------------------------------------------------------------------------
