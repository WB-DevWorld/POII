// Proxies POST /v1/backup and hands the browser the backup JSON as a download.
import { apiRaw } from '@/lib/api';
import { downloadHeaders, isCrossSite, problemResponse } from '@/lib/download';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (isCrossSite(request)) return problemResponse(403, 'cross_site_request', 'Backups can only be requested from POII itself.');
  let upstream: Response;
  try {
    upstream = await apiRaw('/v1/backup', { method: 'POST', body: {} });
  } catch {
    return problemResponse(502, 'api_unreachable', 'The POII API is not reachable. No backup was made.');
  }
  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new Response(upstream.body, { headers: downloadHeaders(`poii-backup-${stamp}.json`, 'application/json; charset=utf-8') });
}
