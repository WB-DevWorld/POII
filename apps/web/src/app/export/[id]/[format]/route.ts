// Proxies a stored export from the API as a download.
import { apiRaw } from '@/lib/api';
import { downloadHeaders, problemResponse } from '@/lib/download';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string; format: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { id, format } = await params;
  if (format !== 'markdown' && format !== 'json') return new Response('Unknown format', { status: 404 });
  let upstream: Response;
  try {
    upstream = await apiRaw(`/v1/exports/${encodeURIComponent(id)}`);
  } catch {
    return problemResponse(502, 'api_unreachable', 'The POII API is not reachable.');
  }
  if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  const data = (await upstream.json()) as Record<string, unknown>;
  const isPack = typeof data.markdown === 'string' && data.manifest;
  const base = isPack ? `poii-context-pack-${id}` : `poii-export-${id}`;
  if (format === 'markdown') {
    if (!isPack) return new Response('This export has no Markdown.', { status: 404 });
    return new Response(data.markdown as string, { headers: downloadHeaders(`${base}.md`, 'text/markdown; charset=utf-8') });
  }
  const json = isPack && data.json ? data.json : data;
  return new Response(JSON.stringify(json, null, 2), { headers: downloadHeaders(`${base}.json`, 'application/json; charset=utf-8') });
}
