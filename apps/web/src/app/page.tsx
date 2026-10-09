import { apiJson } from '@/lib/api';

type Ready = { status: string; version: string; aiEnabled?: boolean };

export default async function HomePage() {
  const ready = await apiJson<Ready>('/health/ready').catch(() => null);
  return (
    <section>
      <h1>Your record of evidence, decisions and current state</h1>
      <p className="lede">
        Paste or upload a source, mark candidates, confirm what was actually decided, and export cited context for the next
        person or AI. Everything works with AI and peers switched off.
      </p>
      <dl className="facts">
        <div>
          <dt>API</dt>
          <dd data-testid="api-status">{ready ? `${ready.status} (${ready.version.slice(0, 12)})` : 'disconnected'}</dd>
        </div>
        <div>
          <dt>AI assistance</dt>
          <dd>{ready?.aiEnabled ? 'on' : 'off'}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>local owner</dd>
        </div>
      </dl>
      <p>
        Start with <a href="/sources/new">a new source</a>.
      </p>
    </section>
  );
}
