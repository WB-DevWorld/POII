import type { Metadata } from 'next';
import type { RecordSummary } from '@poii/contracts';
import { lifecycleStatuses, recordKinds, reviewStates } from '@poii/contracts';
import { AiBadge, Attribution, KindBadge, ReviewBadge, StatusBadge } from '@/components/Badges';
import { PageNotice } from '@/components/PageNotice';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry, query } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';

export const metadata: Metadata = { title: 'Records' };

const PAGE = 50;

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function RecordsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const kind = pick(first(sp.kind), recordKinds);
  const reviewState = pick(first(sp.reviewState), reviewStates);
  const lifecycleStatus = pick(first(sp.lifecycleStatus), lifecycleStatuses);
  const offset = Math.max(0, Number(first(sp.offset) ?? 0) || 0);
  const filters = { kind, reviewState, lifecycleStatus };
  const result = await apiTry<RecordSummary[]>(`/v1/records${query({ ...filters, limit: PAGE, offset })}`);

  return (
    <section>
      <h1>Records</h1>
      <p className="lede">
        Facts, requirements, decisions and questions. Attribution (who said it) and review (who confirmed it) are separate.
        New records start on a <a href="/sources">source page</a> from a selected span.
      </p>
      <PageNotice notice={sp.notice} />
      <form method="get" className="filters" aria-label="Filter records">
        <div>
          <label htmlFor="f-kind">Kind</label>
          <select id="f-kind" name="kind" defaultValue={kind ?? ''}>
            <option value="">Any</option>
            {recordKinds.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-review">Review state</label>
          <select id="f-review" name="reviewState" defaultValue={reviewState ?? ''}>
            <option value="">Any</option>
            {reviewStates.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-status">Lifecycle status</label>
          <select id="f-status" name="lifecycleStatus" defaultValue={lifecycleStatus ?? ''}>
            <option value="">Any</option>
            {lifecycleStatuses.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="filter-actions">
          <button type="submit" className="secondary">Apply</button>
          <a href="/records">Clear</a>
        </div>
      </form>
      {!result.ok ? (
        <ProblemNotice problem={result.problem} title="Records could not be loaded." />
      ) : result.data.length === 0 ? (
        <p className="muted">No records match.</p>
      ) : (
        <ul className="record-list" data-testid="records-list">
          {result.data.map(r => (
            <li key={r.id}>
              <a href={`/records/${r.id}`} className="record-title">{r.title}</a>
              <div className="row tags">
                <KindBadge kind={r.kind} />
                <ReviewBadge state={r.reviewState} />
                <StatusBadge status={r.lifecycleStatus} />
                {r.supersededByRecordId ? <span className="tag warn">superseded</span> : null}
                {r.supersedesRecordId ? <span className="tag">supersedes another record</span> : null}
                {!r.aiAllowed ? <AiBadge allowed={false} /> : null}
              </div>
              <div className="row tags">
                <Attribution by={r.statedByDisplayName} role={r.statedRole} mode={r.statementMode} />
                <span className="hint">recorded {formatTime(r.recordedAt)} · v{r.versionNo}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.ok ? (
        <nav className="row pager" aria-label="Pages">
          {offset > 0 ? <a href={`/records${query({ ...filters, offset: Math.max(0, offset - PAGE) })}`}>Previous</a> : null}
          {result.data.length === PAGE ? <a href={`/records${query({ ...filters, offset: offset + PAGE })}`}>Next</a> : null}
        </nav>
      ) : null}
    </section>
  );
}
