// #19 Proxies one generated agent instructions file (AGENTS.md or CLAUDE.md) from the API as a download.
import { apiRaw } from '@/lib/api';
import { agentFileApiPath, isAgentFileName } from '@/lib/agent-instructions';
import { downloadHeaders, problemResponse } from '@/lib/download';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string; name: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { id, name } = await params;
  if (!isAgentFileName(name)) return new Response('Unknown file', { status: 404 });
  let upstream: Response;
  try {
    upstream = await apiRaw(agentFileApiPath(id, name), { headers: { accept: 'text/markdown' } });
  } catch {
    return problemResponse(502, 'api_unreachable', 'The POII API is not reachable.');
  }
  if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  return new Response(await upstream.text(), { headers: downloadHeaders(name, 'text/markdown; charset=utf-8') });
}
