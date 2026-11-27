import type { Metadata } from 'next';
import type { CurrentDecision } from '@poii/contracts';
import { AnchorBadge, StatusBadge } from '@/components/Badges';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { authorityTerms, codeTitle, labelOf, stalenessTerms } from '@/lib/labels';
import { spanHref } from '@/lib/offsets';

export const metadata: Metadata = { title: 'Current decisions' };

function Staleness({ label, last }: { label: 'observed' | 'stale' | 'unknown'; last: string | null }) {
  const tone = label === 'observed' ? 'ok' : label === 'stale' ? 'warn' : 'danger';
  return (
    <span>
      <span className={`tag ${tone}`} data-testid="staleness" data-code={label} title={codeTitle(stalenessTerms, label)}>
        {labelOf(stalenessTerms, label)}
      </span>
      <span className="hint">{last ? ` last seen in practice ${formatTime(last)}` : ' never recorded as seen in practice'}</span>
    </span>
  );
}

export default async function DecisionsPage() {
  const result = await apiTry<CurrentDecision[]>('/v1/decisions/current');
  return (
    <section>
      <h1>Current decisions</h1>
      <p className="lede">
        Every confirmed decision that no confirmed record has replaced. POII works this list out fresh on every visit from the
        confirmations and replacements; nothing here is edited by hand. Decisions awaiting review are not listed.
      </p>
      {!result.ok ? (
        <ProblemNotice problem={result.problem} title="Current decisions could not be loaded." />
      ) : result.data.length === 0 ? (
        <p className="muted">No confirmed decisions yet. Confirm a decision that is awaiting review to see it here.</p>
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
                Confirmed by <strong>{d.approval.approvedByDisplayName}</strong> (
                <span data-code={d.approval.authority}>{labelOf(authorityTerms, d.approval.authority)}</span> authority) at{' '}
                <time dateTime={d.approval.approvedAt}>{formatTime(d.approval.approvedAt)}</time>
              </p>
              {d.replaced.length ? (
                <div>
                  <span className="muted">Replaced earlier records: </span>
                  <ol className="chain">
                    {d.replaced.map(r => (
                      <li key={r.id}>
                        <a href={`/records/${r.id}`}>{r.title}</a>
                        {r.approvedAt ? <span className="hint"> (confirmed {formatTime(r.approvedAt)})</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="hint">Replaced no earlier record.</p>
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
                      Main evidence: {d.primaryEvidence.sourceTitle ?? 'source'}, lines {d.primaryEvidence.locator.startLine}–
                      {d.primaryEvidence.locator.endLine}
                    </a>{' '}
                    <AnchorBadge result={d.primaryEvidence.anchorResult} />
                  </p>
                ) : (
                  <p>
                    <span className="tag danger" data-code="unavailable">evidence unavailable</span> the quoted source was deleted.
                  </p>
                )
              ) : (
                <p className="hint">No main evidence.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
