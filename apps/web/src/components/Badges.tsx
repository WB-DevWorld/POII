import type { AnchorResult, LifecycleStatus, ReviewState, StatedRole, StatementMode } from '@poii/contracts';
import { describeTime, type ConflictSource, type TimeConflictValue } from '@/lib/format';
import {
  anchorResultTerms,
  codeTitle,
  labelOf,
  lifecycleStatusTerms,
  recordKindTerms,
  reviewStateTerms,
  statedRoleTerms,
  statementModeTerms,
  timeStatusTerms,
  type Term,
} from '@/lib/labels';

/**
 * A tag that shows the plain label and keeps the code in `data-code` and the tooltip (ADR-0014): people read
 * the word, tests, scripts and agents can still read the exact code.
 */
export function CodeTag({
  terms,
  code,
  tone,
  testId,
}: {
  terms: Record<string, Term>;
  code: string;
  tone?: string;
  testId?: string;
}) {
  return (
    <span className={`tag${tone ? ` ${tone}` : ''}`} data-code={code} data-testid={testId} title={codeTitle(terms, code)}>
      {labelOf(terms, code)}
    </span>
  );
}

export function ReviewBadge({ state }: { state: ReviewState }) {
  const tone = state === 'confirmed' ? 'ok' : state === 'rejected' ? 'danger' : 'warn';
  return <CodeTag terms={reviewStateTerms} code={state} tone={tone} testId="review-state" />;
}

export function StatusBadge({ status }: { status: LifecycleStatus }) {
  return <CodeTag terms={lifecycleStatusTerms} code={status} tone={status === 'unknown' ? 'warn' : undefined} testId="lifecycle-status" />;
}

export function KindBadge({ kind }: { kind: string }) {
  return <CodeTag terms={recordKindTerms} code={kind} tone="kind" testId="record-kind" />;
}

export function AiBadge({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="tag" data-code="ai_allowed" title="May be sent to an AI provider when AI is switched on (aiAllowed: true)">
      May be sent to AI
    </span>
  ) : (
    <span className="tag danger" data-code="never_send_to_ai" title="Never sent to any AI provider (aiAllowed: false)">
      Never sent to AI
    </span>
  );
}

export function AnchorBadge({ result }: { result: AnchorResult }) {
  const tone = result === 'exact' ? 'ok' : result === 'moved' ? 'warn' : 'danger';
  return <CodeTag terms={anchorResultTerms} code={result} tone={tone} testId="anchor-result" />;
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
      <span className="tag" data-testid="stated-by">said by {by ?? 'nobody recorded'}</span>
      <CodeTag terms={statedRoleTerms} code={role} tone={role === 'assistant' ? 'warn' : undefined} testId="stated-role" />
      <CodeTag terms={statementModeTerms} code={mode} testId="statement-mode" />
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
        <CodeTag terms={timeStatusTerms} code="conflicting" tone="danger" testId="time-status" />
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
  if (shown.tone === 'unknown') return <span className="tag warn" data-code="unknown" data-testid="time-status">{shown.text}</span>;
  if (shown.tone === 'na') return <span className="muted" data-code="not_applicable" data-testid="time-status">{shown.text}</span>;
  return <time dateTime={value ?? undefined}>{shown.text}</time>;
}
