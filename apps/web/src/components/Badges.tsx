import type { AnchorResult, LifecycleStatus, ReviewState, StatedRole, StatementMode } from '@poii/contracts';
import { describeTime, humanize, type ConflictSource, type TimeConflictValue } from '@/lib/format';

export function ReviewBadge({ state }: { state: ReviewState }) {
  const tone = state === 'confirmed' ? 'ok' : state === 'rejected' ? 'danger' : 'warn';
  return <span className={`tag ${tone}`} data-testid="review-state">{state}</span>;
}

export function StatusBadge({ status }: { status: LifecycleStatus }) {
  return (
    <span className={`tag${status === 'unknown' ? ' warn' : ''}`} title="Lifecycle status">
      {status}
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className="tag kind">{kind}</span>;
}

export function AiBadge({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="tag" title="May be sent to an AI provider when AI is on">AI allowed</span>
  ) : (
    <span className="tag danger" title="Never sent to any AI provider">never send to AI</span>
  );
}

export function AnchorBadge({ result }: { result: AnchorResult }) {
  const tone = result === 'exact' ? 'ok' : result === 'moved' ? 'warn' : 'danger';
  return <span className={`tag ${tone}`} title="How the span matched the current revision">{result}</span>;
}

/** Who said it, in which role and mode. Never mixed with approval. */
export function Attribution({
  by,
  role,
  mode,
}: {
  by: string | null;
  role: StatedRole;
  mode: StatementMode;
}) {
  return (
    <span className="attribution" data-testid="attribution">
      <span className="tag">said by {by ?? 'unknown'}</span>
      <span className={`tag${role === 'assistant' ? ' warn' : ''}`}>role {humanize(role)}</span>
      <span className="tag">{humanize(mode)}</span>
    </span>
  );
}

export function TimeValue({
  value,
  status,
  conflicts,
  sources = [],
}: {
  value: string | null;
  status: string;
  conflicts?: TimeConflictValue[] | null;
  /** Titles for the sources competing values name; a source that is not listed is linked without a title. */
  sources?: ConflictSource[];
}) {
  const shown = describeTime(value, status, conflicts ?? null);
  // describeTime lists the competing values in their own order; only then does a value's source line up.
  const sourceIds = shown.conflicts.length === (conflicts?.length ?? 0) ? (conflicts ?? []).map(c => c.sourceId) : [];
  if (shown.tone === 'conflicting') {
    return (
      <span>
        <span className="tag danger">conflicting</span>
        {shown.conflicts.length ? (
          <ul className="compact">
            {shown.conflicts.map((c, i) => {
              const sourceId = sourceIds[i];
              return (
                <li key={i}>
                  {c}
                  {sourceId ? (
                    <>
                      {' · source: '}
                      <a href={`/sources/${sourceId}`} data-testid="conflict-source">
                        {sources.find(s => s.id === sourceId)?.title ?? `not cited by this record (…${sourceId.slice(-8)})`}
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="muted"> no competing values recorded</span>
        )}
      </span>
    );
  }
  if (shown.tone === 'unknown') return <span className="tag warn">{shown.text}</span>;
  if (shown.tone === 'na') return <span className="muted">{shown.text}</span>;
  return <time dateTime={value ?? undefined}>{shown.text}</time>;
}
