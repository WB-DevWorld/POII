// Server-side calls for AccessLobby sign-in and "Connect AccessLobby" (ADR-0012): the API's status and starting a
// flow. Starting a flow asks the API for AccessLobby's authorization URL and a one-time binding secret and keeps
// the binding in this browser's short-lived flow cookie (see ./flow.ts).
import { cookies } from 'next/headers';
import { AccessLobbyFlowStarted, AccessLobbyStatus } from '@poii/contracts';
import { apiRaw } from '@/lib/api';
import { errorCode, FLOW_COOKIE, flowCookieOptions, parseFlowCookie, type FlowIntent } from './flow';

/** The API's AccessLobby status, or null when AccessLobby is not configured (404) or the API cannot be asked. */
export async function accessLobbyStatus(): Promise<AccessLobbyStatus | null> {
  try {
    const response = await apiRaw('/v1/auth/accesslobby/status', { method: 'GET' });
    if (!response.ok) return null;
    const parsed = AccessLobbyStatus.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Starts a flow at the API and remembers its binding in this browser. Returns AccessLobby's authorization URL
 * (the caller redirects there) or an error code.
 */
export async function startFlow(intent: FlowIntent, next?: string): Promise<{ url: string } | { code: string }> {
  let response: Response;
  try {
    response = await apiRaw(intent === 'link' ? '/v1/auth/accesslobby/link' : '/v1/auth/accesslobby/sign-in', {
      method: 'POST',
      body: intent === 'signin' && next ? { next } : {},
    });
  } catch {
    return { code: 'api_unreachable' };
  }
  if (!response.ok) return { code: await errorCode(response) };
  const parsed = AccessLobbyFlowStarted.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !/^https?:\/\//.test(parsed.data.url)) return { code: 'accesslobby_unavailable' };
  const value = `${intent}.${parsed.data.binding}`;
  if (!parseFlowCookie(value)) return { code: 'accesslobby_unavailable' };
  (await cookies()).set(FLOW_COOKIE, value, flowCookieOptions());
  return { url: parsed.data.url };
}
