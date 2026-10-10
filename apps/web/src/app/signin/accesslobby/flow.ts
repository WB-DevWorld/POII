// AccessLobby sign-in and "Connect AccessLobby" on the web side (ADR-0012). Server-only: the browser never talks
// to the API. Starting a flow asks the API for AccessLobby's authorization URL and a one-time binding secret; the
// binding goes into this app's short-lived HttpOnly cookie (path /signin/accesslobby), so only the browser that
// started the flow can finish it at /signin/accesslobby/callback. The registered callback, post-logout and
// back-channel logout URLs all live under /signin/accesslobby on the web origin (the proxy does not run there).
// Pure helpers live here (unit-tested); the calls to the API are in ./start.ts.
import { isSecureBaseUrl } from '@/lib/session';

/** This app's cookie for a running AccessLobby flow: `<intent>.<binding>`. */
export const FLOW_COOKIE = 'poii_accesslobby_flow';
export const FLOW_COOKIE_PATH = '/signin/accesslobby';
const FLOW_SECONDS = 600;

export type FlowIntent = 'signin' | 'link';

export function flowCookieOptions(maxAge = FLOW_SECONDS) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: isSecureBaseUrl(process.env.WEB_BASE_URL), path: FLOW_COOKIE_PATH, maxAge };
}

/** `<intent>.<binding>` → parts, or null for anything else. */
export function parseFlowCookie(value: string | undefined): { intent: FlowIntent; binding: string } | null {
  const match = /^(signin|link)\.([A-Za-z0-9_-]{16,128})$/.exec(value ?? '');
  return match ? { intent: match[1] as FlowIntent, binding: match[2]! } : null;
}

/** Plain-language text for the codes the API's AccessLobby endpoints answer (lower case, as the web app shows codes). */
const MESSAGES: Record<string, string> = {
  accesslobby_unavailable: 'AccessLobby cannot be reached right now. Nothing was changed; try again later.',
  not_linked: 'This AccessLobby account is not connected to this POII. Sign in with your password, then use "Connect AccessLobby" on the Account page.',
  invalid_flow: 'This AccessLobby sign-in expired or was started in another browser. Start again.',
  accesslobby_denied: 'AccessLobby did not complete the sign-in.',
  issuer_mismatch: 'The answer came from a different AccessLobby issuer. Nothing was changed.',
  code_rejected: 'AccessLobby did not accept the sign-in. Start again.',
  invalid_id_token: 'AccessLobby returned an identity POII could not verify. Nothing was changed.',
  invalid_access_token: 'AccessLobby returned an access token POII could not verify. Nothing was changed.',
  accesslobby_token_rejected: 'The AccessLobby identity service did not accept the sign-in.',
  person_suspended: 'This AccessLobby person is suspended.',
  identity_conflict: 'AccessLobby now reports a different person for the connected account. The link needs a manual review; nothing was changed.',
  link_session_mismatch: 'Your POII session ended or changed while connecting AccessLobby. Sign in with your password and connect again.',
  already_linked: 'An AccessLobby account is already connected. Disconnect it first.',
  identity_already_linked: 'This AccessLobby account is already connected to a POII user.',
  person_already_linked: 'This AccessLobby person is already connected to a POII user.',
  no_link: 'No AccessLobby account is connected.',
  invalid_password: 'The password is wrong. Nothing was changed.',
  too_many_attempts: 'Too many attempts; try again in a few seconds.',
  api_unreachable: 'The POII API is not reachable right now. Nothing was changed.',
};

export const accessLobbyMessage = (code: string | undefined): string | null => (code ? MESSAGES[code] ?? null : null);

/** A code from an API error body, reduced to `[a-z0-9_]` so it is safe in a URL and in the page. */
export async function errorCode(response: Response): Promise<string> {
  if (response.status === 429) return 'too_many_attempts';
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64) : '';
  return code || `http_${response.status}`;
}
