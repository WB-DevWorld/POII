// AccessLobby's redirect back to POII (the registered redirect URI). Hands code, state and iss together with this
// browser's flow binding (and, for "Connect AccessLobby", its POII session) to the API, which verifies everything
// (ADR-0012). On a sign-in it copies the new session into this app's own cookie, like the password sign-in does.
import { NextResponse, type NextRequest } from 'next/server';
import { AccessLobbyCallbackResponse } from '@poii/contracts';
import { apiRaw } from '@/lib/api';
import { parseSessionSetCookie, safeNextPath, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { errorCode, FLOW_COOKIE, flowCookieOptions, parseFlowCookie } from '../flow';

export const dynamic = 'force-dynamic';

const param = (request: NextRequest, name: string, max: number): string | undefined => {
  const value = request.nextUrl.searchParams.get(name);
  return value && value.length <= max ? value : undefined;
};

export async function GET(request: NextRequest) {
  const base = process.env.WEB_BASE_URL ?? request.url;
  const flow = parseFlowCookie(request.cookies.get(FLOW_COOKIE)?.value);
  const done = (path: string) => {
    const response = NextResponse.redirect(new URL(path, base), 303);
    response.headers.set('cache-control', 'no-store');
    // One attempt per flow: the cookie goes whatever happens.
    response.cookies.set(FLOW_COOKIE, '', flowCookieOptions(0));
    return response;
  };
  const fail = (code: string) => done(flow?.intent === 'link' ? `/account?accesslobby=${code}` : `/signin?accesslobby=${code}`);
  const state = param(request, 'state', 512);
  if (!flow || !state) return fail('invalid_flow');

  let upstream: Response;
  try {
    upstream = await apiRaw('/v1/auth/accesslobby/callback', {
      method: 'POST',
      body: {
        state,
        binding: flow.binding,
        ...(param(request, 'code', 4096) ? { code: param(request, 'code', 4096) } : {}),
        ...(param(request, 'iss', 1024) ? { iss: param(request, 'iss', 1024) } : {}),
        ...(param(request, 'error', 200) ? { error: param(request, 'error', 200) } : {}),
      },
    });
  } catch {
    return fail('api_unreachable');
  }
  if (!upstream.ok) return fail(await errorCode(upstream));
  const parsed = AccessLobbyCallbackResponse.safeParse(await upstream.json().catch(() => null));
  if (!parsed.success || parsed.data.intent !== flow.intent) return fail('invalid_flow');
  const body = parsed.data;
  if (body.intent === 'link') return done('/account?accesslobby=connected');
  const issued = parseSessionSetCookie(upstream.headers.getSetCookie());
  if (!issued) return fail('invalid_flow');
  const response = done(safeNextPath(body.next));
  response.cookies.set(SESSION_COOKIE, issued.value, sessionCookieOptions(issued, process.env.WEB_BASE_URL));
  return response;
}
