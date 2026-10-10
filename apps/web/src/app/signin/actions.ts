'use server';

// Sign-in and sign-out (ADR-0009). The API's Better Auth checks the password and issues the session; the web
// app copies the signed session token from the API's Set-Cookie into its own HttpOnly cookie and forwards it on
// every API call (lib/api.ts), with the web app's Origin so Better Auth's trusted-origin check passes.
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ActionState } from '@/lib/action-state';
import { apiRaw, ApiError, toProblem } from '@/lib/api';
import { parseSessionSetCookie, safeNextPath, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';

const text = (fd: FormData, name: string): string => {
  const value = fd.get(name);
  return typeof value === 'string' ? value : '';
};

async function failure(response: Response): Promise<ActionState> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = (body as { code?: unknown } | null)?.code;
  // Better Auth answers `{ code, message }` on /v1/auth/*.
  const problem = toProblem(new ApiError(response.status, { error: typeof code === 'string' ? code.toLowerCase() : `http_${response.status}`, ...(body as object) }));
  // A failed sign-in is not "signed out", it is a wrong login or password (422: a malformed username).
  if (response.status === 401 || response.status === 422) {
    return { ok: false, problem: { ...problem, message: 'Login or password is wrong.' } };
  }
  if (response.status === 429) {
    const wait = Number(response.headers.get('x-retry-after'));
    const seconds = Number.isFinite(wait) && wait > 0 ? ` in ${wait} s` : ' in a moment';
    return { ok: false, problem: { ...problem, code: 'too_many_attempts', message: `Too many attempts; try again${seconds}.` } };
  }
  return { ok: false, problem };
}

export async function signInAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const login = text(fd, 'login').trim();
  const password = text(fd, 'password');
  if (!login || !password) return { ok: false, problem: { code: 'invalid_input', message: 'Enter your login and password.' } };
  let response: Response;
  try {
    // The browser's address as this server saw it, for the API's rate limiter (used only with POII_TRUST_PROXY=true).
    const client = (await headers()).get('x-forwarded-for')?.split(',').map(p => p.trim()).filter(Boolean).pop();
    response = await apiRaw('/v1/auth/sign-in/username', {
      method: 'POST',
      body: { username: login, password },
      ...(client && client.length <= 64 ? { headers: { 'x-forwarded-for': client } } : {}),
    });
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
  if (!response.ok) return failure(response);
  const issued = parseSessionSetCookie(response.headers.getSetCookie());
  if (!issued) return { ok: false, problem: { code: 'no_session', message: 'The API did not issue a session.' } };
  (await cookies()).set(SESSION_COOKIE, issued.value, sessionCookieOptions(issued, process.env.WEB_BASE_URL));
  redirect(safeNextPath(text(fd, 'next')));
}

/** Ends this browser's session at the API (immediately) and drops the cookie. */
export async function signOutAction(): Promise<void> {
  try {
    await apiRaw('/v1/auth/sign-out', { method: 'POST', body: {} });
  } catch {
    // The cookie is dropped anyway; the API-side session expires on its own if the API was unreachable.
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/signin?signedOut=1');
}

/** Ends every session of the signed-in owner, on every device. */
export async function signOutEverywhereAction(_state: ActionState, _fd: FormData): Promise<ActionState> {
  let response: Response;
  try {
    response = await apiRaw('/v1/auth/revoke-sessions', { method: 'POST', body: {} });
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
  if (!response.ok) return failure(response);
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/signin?signedOut=all');
}
