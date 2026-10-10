// Thin HTTP client for the POII read API. Every request carries the owner token (scope read) and
// X-POII-AI-Context: 1, so the API applies the never-send-to-AI rule (docs/api.md). No retries: an error goes back
// to the caller with the API's own code, and no other credential is ever tried.
import { AI_CONTEXT_HEADER, WITHHELD_HEADER } from '@poii/contracts';

export interface ApiConfig {
  /** Base URL of the POII API, e.g. http://127.0.0.1:3001 (no trailing /v1). */
  apiUrl: string;
  /** Owner token `poii_…` with scope read. */
  token: string;
}

export type ApiResult =
  | { ok: true; status: number; body: unknown; withheld: number | null }
  | { ok: false; status: number; error: string; message: string; requestId: string | null; details?: unknown };

const TOKEN_PATTERN = /^poii_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Reads POII_API_URL and POII_TOKEN. Throws with a readable message (never echoing the token) when either is unusable. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawUrl = env.POII_API_URL?.trim();
  if (!rawUrl) throw new Error('POII_API_URL is not set (for example http://127.0.0.1:3001)');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('POII_API_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('POII_API_URL must use https, or http on a loopback address; the token would otherwise travel in clear text');
  }
  const token = env.POII_TOKEN?.trim();
  if (!token) throw new Error('POII_TOKEN is not set (an owner token with scope read, created on the POII tokens page)');
  if (!TOKEN_PATTERN.test(token)) throw new Error('POII_TOKEN does not look like a POII owner token (poii_ followed by 43 characters)');
  return { apiUrl: url.toString().replace(/\/+$/, ''), token };
}

export function createApiClient(config: ApiConfig, fetchImpl: typeof fetch = fetch) {
  return async function get(path: string, query: Record<string, string | number | undefined> = {}): Promise<ApiResult> {
    const url = new URL(`${config.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${config.token}`, [AI_CONTEXT_HEADER]: '1' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, status: 0, error: 'api_unreachable', message: `POII API not reachable: ${(error as Error).message}`, requestId: null };
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const e = (body ?? {}) as { error?: unknown; message?: unknown; requestId?: unknown; details?: unknown };
      return {
        ok: false,
        status: response.status,
        error: typeof e.error === 'string' ? e.error : `http_${response.status}`,
        message: typeof e.message === 'string' ? e.message : `HTTP ${response.status}`,
        requestId: typeof e.requestId === 'string' ? e.requestId : response.headers.get('x-request-id'),
        ...(e.details !== undefined ? { details: e.details } : {}),
      };
    }
    const withheld = response.headers.get(WITHHELD_HEADER);
    return { ok: true, status: response.status, body, withheld: withheld === null ? null : Number(withheld) };
  };
}
export type ApiGet = ReturnType<typeof createApiClient>;
