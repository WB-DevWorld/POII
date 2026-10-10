// Server-side access to the POII API. The web app never talks to the database directly.
// Every call forwards the browser's session token (local-signin), the CSRF header and the web app's Origin (ADR-0009).
import { PATH_HEADER, safeNextPath, sessionHeaders, SESSION_COOKIE } from './session';
export const apiBase = () => process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

/** The API's error body: `{ error, message, requestId, details? }`. */
export type ApiErrorBody = { error: string; message: string; requestId?: string; details?: unknown };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`API ${status}`);
  }

  get code(): string {
    const body = this.body as Partial<ApiErrorBody> | null;
    return typeof body?.error === 'string' ? body.error : `http_${this.status}`;
  }

  get detail(): string {
    const body = this.body as Partial<ApiErrorBody> | null;
    return typeof body?.message === 'string' ? body.message : `The API answered with status ${this.status}.`;
  }

  get requestId(): string | undefined {
    const body = this.body as Partial<ApiErrorBody> | null;
    return typeof body?.requestId === 'string' ? body.requestId : undefined;
  }
}

export type JsonInit = Omit<RequestInit, 'body'> & { body?: unknown; idempotencyKey?: string };

/** `/signin`, with `next` set to the page being rendered when the proxy told us which one it is. */
export async function signInPath(): Promise<string> {
  let next = '/';
  try {
    const { headers } = await import('next/headers');
    next = safeNextPath((await headers()).get(PATH_HEADER));
  } catch (error) {
    const { unstable_rethrow } = await import('next/navigation');
    unstable_rethrow(error);
  }
  return next === '/' ? '/signin' : `/signin?next=${encodeURIComponent(next)}`;
}

/** The browser's session cookie, when called inside a request (pages, actions, route handlers); else undefined. */
export async function currentSession(): Promise<string | undefined> {
  try {
    const { cookies } = await import('next/headers');
    return (await cookies()).get(SESSION_COOKIE)?.value;
  } catch (error) {
    // Inside Next, rethrow its own control-flow errors (dynamic rendering bail-out); outside a request
    // (unit tests, scripts) there is simply no session.
    const { unstable_rethrow } = await import('next/navigation');
    unstable_rethrow(error);
    return undefined;
  }
}

async function buildInit(init: JsonInit): Promise<RequestInit> {
  const { body, idempotencyKey, headers, ...rest } = init;
  const extra: Record<string, string> = sessionHeaders(await currentSession());
  if (idempotencyKey) extra['idempotency-key'] = idempotencyKey;
  return {
    ...rest,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...extra, ...((headers as Record<string, string>) ?? {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    cache: 'no-store',
  };
}

export async function apiJson<T>(path: string, init: JsonInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, await buildInit(init));
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `http_${response.status}`, message: text.slice(0, 500) };
    }
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

/** Raw response, for route handlers that proxy a download. */
export async function apiRaw(path: string, init: JsonInit = {}): Promise<Response> {
  return fetch(`${apiBase()}${path}`, await buildInit(init));
}

/** A readable problem: the API's error code and message, or a connection failure. */
export type Problem = { code: string; message: string; status?: number; requestId?: string; issues?: string[] };

export function toProblem(error: unknown): Problem {
  if (error instanceof ApiError && error.status === 401) {
    return { code: error.code, message: 'You are signed out. Sign in again to continue.', status: 401, requestId: error.requestId };
  }
  if (error instanceof ApiError) {
    const issues = issueLines((error.body as Partial<ApiErrorBody> | null)?.details);
    return { code: error.code, message: error.detail, status: error.status, requestId: error.requestId, ...(issues.length ? { issues } : {}) };
  }
  if (error instanceof Error) return { code: 'api_unreachable', message: `The API could not be reached (${error.message}).` };
  return { code: 'unknown_error', message: 'Something went wrong.' };
}

/** Validation details (zod issues) as short readable lines: "field.path: message". */
export function issueLines(details: unknown, max = 6): string[] {
  if (!Array.isArray(details)) return [];
  return details.slice(0, max).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') return [];
    const where = Array.isArray(path) && path.length ? `${path.join('.')}: ` : '';
    return [`${where}${message}`];
  });
}

export type Result<T> = { ok: true; data: T } | { ok: false; problem: Problem };

/**
 * Like apiJson, but never throws: pages render a notice instead of crashing. A 401 (signed out under
 * local-signin) sends the browser to the sign-in page instead.
 */
export async function apiTry<T>(path: string, init: JsonInit = {}): Promise<Result<T>> {
  let result: Result<T>;
  try {
    result = { ok: true, data: await apiJson<T>(path, init) };
  } catch (error) {
    result = { ok: false, problem: toProblem(error) };
  }
  if (!result.ok && result.problem.status === 401) {
    const { redirect } = await import('next/navigation');
    redirect(await signInPath());
  }
  return result;
}

/** Builds a query string from defined, non-empty values. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
