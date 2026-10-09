import type { Metadata } from 'next';
import type { CurrentDecision } from '@poii/contracts';
import { AnchorBadge, StatusBadge } from '@/components/Badges';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { spanHref } from '@/lib/offsets';

export const metadata: Metadata = { title: 'Current decisions' };

function Staleness({ label, last }: { label: 'observed' | 'stale' | 'unknown'; last: string | null }) {
  const tone = label === 'observed' ? 'ok' : label === 'stale' ? 'warn' : 'danger';
  return (
    <span>
      <span className={`tag ${tone}`} data-testid="staleness">{label}</span>
      <span className="hint">{last ? ` last observed ${formatTime(last)}` : ' never observed'}</span>
    </span>
  );
}

export default async function DecisionsPage() {
  const result = await apiTry<CurrentDecision[]>('/v1/decisions/current');
  return (
    <section>
      <h1>Current decisions</h1>
      <p className="lede">
        Derived on every visit from approvals and supersession: confirmed decisions that no confirmed successor replaces. Nothing
        here is edited by hand.
      </p>
      {!result.ok ? (
        <ProblemNotice problem={result.problem} title="Current decisions could not be loaded." />
      ) : result.data.length === 0 ? (
        <p className="muted">No confirmed decisions yet. Confirm a decision candidate to see it here.</p>
      ) : (
        <ul className="decisions" data-testid="decisions-list">
          {result.data.map(d => (
            <li key={d.record.id} className="card" data-testid="decision">
              <h2 className="decision-title">
                <a href={`/records/${d.record.id}`}>{d.record.title}</a>
              </h2>
              <p className="row tags">
                <StatusBadge status={d.record.lifecycleStatus} />
                <Staleness label={d.staleness.label} last={d.staleness.lastObservedAt} />
              </p>
              <p>
                Approved by <strong>{d.approval.approvedByDisplayName}</strong> ({d.approval.authority}) at{' '}
                <time dateTime={d.approval.approvedAt}>{formatTime(d.approval.approvedAt)}</time>
              </p>
              {d.replaced.length ? (
                <div>
                  <span className="muted">Replaced: </span>
                  <ol className="chain">
                    {d.replaced.map(r => (
                      <li key={r.id}>
                        <a href={`/records/${r.id}`}>{r.title}</a>
                        {r.approvedAt ? <span className="hint"> (approved {formatTime(r.approvedAt)})</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="hint">Replaced nothing.</p>
              )}
              {d.primaryEvidence ? (
                d.primaryEvidence.available && d.primaryEvidence.sourceId ? (
                  <p>
                    <a
                      href={spanHref(
                        d.primaryEvidence.sourceId,
                        d.primaryEvidence.revisionId ?? d.primaryEvidence.locator.revisionId,
                        d.primaryEvidence.locator.startChar,
                        d.primaryEvidence.locator.endChar,
                      )}
                    >
                      Primary evidence: {d.primaryEvidence.sourceTitle ?? 'source'}, lines {d.primaryEvidence.locator.startLine}–
                      {d.primaryEvidence.locator.endLine}
                    </a>{' '}
                    <AnchorBadge result={d.primaryEvidence.anchorResult} />
                  </p>
                ) : (
                  <p>
                    <span className="tag danger">evidence unavailable</span> the cited source was deleted.
                  </p>
                )
              ) : (
                <p className="hint">No primary evidence.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
