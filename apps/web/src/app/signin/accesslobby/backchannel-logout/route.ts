// The registered back-channel logout endpoint (OpenID Connect Back-Channel Logout 1.0, ADR-0012). AccessLobby
// posts `logout_token` here server to server: no cookie, no Origin. It is relayed to the API, which verifies the
// token against AccessLobby's JWKS and ends the sessions; this route forwards nothing else (in particular no
// session cookie) and answers only the status: 200, or 400 for an invalid token.
import { apiBase } from '@/lib/api';

export const dynamic = 'force-dynamic';

const reply = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(request: Request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) return reply(400);
  const text = await request.text();
  if (text.length > 20_000) return reply(400);
  const token = new URLSearchParams(text).get('logout_token');
  if (!token) return reply(400);
  try {
    const upstream = await fetch(`${apiBase()}/v1/auth/accesslobby/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ logout_token: token }),
      cache: 'no-store',
    });
    return reply(upstream.status === 200 ? 200 : upstream.status >= 500 ? 503 : 400);
  } catch {
    // AccessLobby may retry; a 503 says the logout was not processed.
    return reply(503);
  }
}
