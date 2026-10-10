// The registered post-logout redirect URI: AccessLobby sends the browser here after "Sign out of all connected
// apps" (RP-initiated logout). POII's own sessions were already ended before the browser went to AccessLobby.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return NextResponse.redirect(new URL('/signin?signedOut=accesslobby', process.env.WEB_BASE_URL ?? request.url), 303);
}
