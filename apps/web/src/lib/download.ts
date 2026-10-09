// Helpers for route handlers that hand the browser a file.

/** Headers for an attachment download; the file name is restricted to safe characters. */
export function downloadHeaders(fileName: string, contentType: string): Headers {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Headers({
    'content-type': contentType,
    'content-disposition': `attachment; filename="${safe}"`,
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
}

export function problemResponse(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), { status, headers: { 'content-type': 'application/json' } });
}

/** True when a state-changing request comes from another site (cross-site form post). */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
