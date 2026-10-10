// Session handling for the web app (ADR-0009). Under local-signin the API's Better Auth issues the session; the
// browser holds its signed session token in this app's own HttpOnly cookie on the web origin, and the web server
// forwards it to the API on every call, together with the CSRF header and the web app's Origin. Nothing here
// runs in the browser.
/** The web app's own cookie that carries the API session token. */
export const SESSION_COOKIE = 'poii_session';
/** Same values as AUTH_SESSION_COOKIE(_SECURE) and CSRF_HEADER in @poii/contracts (kept local so the proxy stays dependency-free; a test checks they match). */
export const API_SESSION_COOKIE = 'poii.session_token';
export const API_SESSION_COOKIE_SECURE = '__Secure-poii.session_token';
export const CSRF_HEADER = 'x-poii-csrf';
/** Request header the proxy sets (always overwriting any incoming one) with the requested path and query. */
export const PATH_HEADER = 'x-poii-path';

/** A session cookie handed out by the API's sign-in endpoint. */
export type IssuedCookie = { value: string; expires?: Date; maxAge?: number };

/** Better Auth's signed token as it appears in the cookie: `<token>.<signature>`, URL-encoded. */
const SESSION_VALUE = /^[A-Za-z0-9._%-]{1,512}$/;
const isSessionValue = (value: string) => SESSION_VALUE.test(value);

/** Finds and parses the API session cookie (either name) among Set-Cookie lines. Empty values (a cleared cookie) give null. */
export function parseSessionSetCookie(lines: readonly string[]): IssuedCookie | null {
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = eq === -1 ? '' : pair.slice(0, eq).trim();
    if (name !== API_SESSION_COOKIE && name !== API_SESSION_COOKIE_SECURE) continue;
    const value = pair.slice(eq + 1).trim();
    if (!value || !isSessionValue(value)) return null;
    const cookie: IssuedCookie = { value };
    for (const attribute of attributes) {
      const [rawName, ...rest] = attribute.split('=');
      const attrName = rawName?.trim().toLowerCase();
      const attrValue = rest.join('=').trim();
      if (attrName === 'expires') {
        const date = new Date(attrValue);
        if (!Number.isNaN(date.getTime())) cookie.expires = date;
      } else if (attrName === 'max-age' && /^\d+$/.test(attrValue)) {
        cookie.maxAge = Number(attrValue);
      }
    }
    return cookie;
  }
  return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Cookies are Secure unless the web app is served from a loopback address (plain-HTTP local use). Unknown → Secure. */
export function isSecureBaseUrl(webBaseUrl: string | undefined): boolean {
  if (!webBaseUrl) return true;
  try {
    const url = new URL(webBaseUrl);
    const host = url.hostname.toLowerCase();
    if (LOOPBACK.has(host) || host.endsWith('.localhost')) return false;
    return true;
  } catch {
    return true;
  }
}

/** Attributes for setting the session cookie on the web origin. */
export function sessionCookieOptions(issued: IssuedCookie, webBaseUrl: string | undefined) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureBaseUrl(webBaseUrl),
    path: '/',
    ...(issued.expires ? { expires: issued.expires } : {}),
    ...(issued.maxAge !== undefined ? { maxAge: issued.maxAge } : {}),
  };
}

/** The web app's origin (from WEB_BASE_URL), or undefined when it is not set or not a URL. */
export function webOrigin(webBaseUrl: string | undefined = process.env.WEB_BASE_URL): string | undefined {
  if (!webBaseUrl) return undefined;
  try {
    return new URL(webBaseUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * Headers that carry the browser's session to the API: always the CSRF header and the web app's Origin
 * (Better Auth refuses cookie-carrying changes without a trusted Origin); the session token, when it looks
 * like one, under both of Better Auth's cookie names (the API reads the one its Secure-cookie setting uses).
 */
export function sessionHeaders(sessionValue: string | undefined, webBaseUrl: string | undefined = process.env.WEB_BASE_URL): Record<string, string> {
  const headers: Record<string, string> = { [CSRF_HEADER]: '1' };
  const origin = webOrigin(webBaseUrl);
  if (origin) headers.origin = origin;
  if (sessionValue && isSessionValue(sessionValue)) {
    headers.cookie = `${API_SESSION_COOKIE}=${sessionValue}; ${API_SESSION_COOKIE_SECURE}=${sessionValue}`;
  }
  return headers;
}

/** Where to go after signing in: only same-site absolute paths, never another origin. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/';
  // Control characters and spaces (tab, CR, LF …) are stripped or reinterpreted by URL parsers: refuse them.
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x21 || c === 0x7f) return '/';
  }
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  const base = 'http://poii.invalid';
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/';
  const path = `${url.pathname}${url.search}`;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/signin')) return '/';
  return path;
}
