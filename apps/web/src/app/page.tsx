import type { CurrentDecision, HealthReady, RecordSummary, SourceView } from '@poii/contracts';
import { apiTry } from '@/lib/api';
import { countLabel } from '@/lib/format';

const LIMIT = 200;

export default async function HomePage() {
  const [ready, sources, candidates, records, decisions] = await Promise.all([
    apiTry<HealthReady>('/health/ready'),
    apiTry<SourceView[]>(`/v1/sources?archived=all&limit=${LIMIT}`),
    apiTry<RecordSummary[]>(`/v1/records?reviewState=candidate&limit=${LIMIT}`),
    apiTry<RecordSummary[]>(`/v1/records?limit=${LIMIT}`),
    apiTry<CurrentDecision[]>('/v1/decisions/current'),
  ]);
  const count = (r: { ok: true; data: unknown[] } | { ok: false }) => (r.ok ? countLabel(r.data.length, LIMIT) : '—');
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
          <dd data-testid="api-status">{ready.ok ? `${ready.data.status} (${ready.data.version.slice(0, 12)})` : 'disconnected'}</dd>
        </div>
        <div>
          <dt>AI assistance</dt>
          <dd>{ready.ok && ready.data.aiEnabled ? 'on' : 'off'}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>local owner</dd>
        </div>
      </dl>
      <dl className="facts" aria-label="Workspace counts">
        <div>
          <dt>Sources</dt>
          <dd data-testid="count-sources"><a href="/sources?archived=all">{count(sources)}</a></dd>
        </div>
        <div>
          <dt>Records</dt>
          <dd data-testid="count-records"><a href="/records">{count(records)}</a></dd>
        </div>
        <div>
          <dt>Candidates to review</dt>
          <dd data-testid="count-candidates"><a href="/records?reviewState=candidate">{count(candidates)}</a></dd>
        </div>
        <div>
          <dt>Current decisions</dt>
          <dd data-testid="count-decisions"><a href="/decisions">{count(decisions)}</a></dd>
        </div>
      </dl>
      <h2>Quick links</h2>
      <ul className="quick-links">
        <li><a className="button" href="/sources/new">Add a source</a></li>
        <li><a className="button secondary" href="/records?reviewState=candidate">Review candidates</a></li>
        <li><a className="button secondary" href="/decisions">Current decisions</a></li>
        <li><a className="button secondary" href="/search">Search</a></li>
        <li><a className="button secondary" href="/export">Export a context pack</a></li>
        <li><a className="button secondary" href="/backup">Back up or restore</a></li>
      </ul>
    </section>
  );
}
