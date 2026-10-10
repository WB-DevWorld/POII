// Next 16 request proxy (the renamed middleware; Node.js runtime). Two jobs (ADR-0009):
// 1. State-changing requests from another site are refused before they reach a route handler or action
//    (server actions additionally get Next's own Origin/Host check).
// 2. Page navigations ask the API who is signed in; a 401 (local-signin without a valid session) redirects
//    to /signin and drops a dead cookie. With local-owner the API always answers 200, so nothing changes.
import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER, SESSION_COOKIE, sessionHeaders } from '@/lib/session';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function crossSite(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Continue, telling server components which path was requested (for the sign-in redirect's `next`). */
function pass(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  if (!SAFE.has(request.method)) {
    if (crossSite(request)) {
      return NextResponse.json({ error: 'cross_site_request', message: 'Changes can only be made from POII itself.' }, { status: 403 });
    }
    return pass(request);
  }
  // Prefetches and RSC requests follow the same rule as full navigations: the page itself checks again.
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  let status: number;
  try {
    const response = await fetch(`${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}/v1/me`, {
      headers: { accept: 'application/json', ...sessionHeaders(session) },
      cache: 'no-store',
    });
    status = response.status;
  } catch {
    return pass(request); // API unreachable: let the page render its own notice.
  }
  if (status !== 401) return pass(request);
  const target = new URL('/signin', request.url);
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (next !== '/') target.searchParams.set('next', next);
  const redirect = NextResponse.redirect(target);
  if (session) redirect.cookies.delete(SESSION_COOKIE);
  return redirect;
}

export const config = {
  // Everything except the sign-in page, Next internals and static files.
  matcher: ['/((?!signin|_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icons/|.*\\.(?:png|svg|ico|webmanifest|txt)$).*)'],
};
