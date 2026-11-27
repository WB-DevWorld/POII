import type { Metadata } from 'next';
import type { ActorView, MeResponse, RecordDetail } from '@poii/contracts';
import { lifecycleStatuses } from '@poii/contracts';
import {
  confirmRecordAction,
  deleteRecordAction,
  rejectRecordAction,
  removeEvidenceAction,
  setStatusAction,
  updateRecordAction,
} from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { AiBadge, AnchorBadge, CodeTag, KindBadge, ReviewBadge, StatusBadge, TimeValue } from '@/components/Badges';
import { PageNotice } from '@/components/PageNotice';
import { ProblemNotice } from '@/components/ProblemNotice';
import { RecordFields, TimeInputs } from '@/components/RecordFields';
import { apiTry } from '@/lib/api';
import { conflictSourceList, conflictsFor, formatTime, inputFromIso } from '@/lib/format';
import {
  authorityTerms,
  changeKindTerms,
  codeTitle,
  evidenceRoleTerms,
  labelOf,
  lifecycleStatusTerms,
  statedRoleTerms,
  statementModeTerms,
  timeStatusTerms,
} from '@/lib/labels';
import type { SearchParams } from '@/lib/notices';
import { spanHref } from '@/lib/offsets';

export const metadata: Metadata = { title: 'Record' };

type Params = Promise<{ id: string }>;

function shortId(id: string) {
  return id.slice(-8);
}

export default async function RecordPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const [result, me, actors] = await Promise.all([
    apiTry<RecordDetail>(`/v1/records/${encodeURIComponent(id)}`),
    apiTry<MeResponse>('/v1/me'),
    apiTry<ActorView[]>('/v1/actors'),
  ]);

  if (!result.ok) {
    return (
      <section>
        <h1>Record</h1>
        <PageNotice notice={sp.notice} />
        {result.problem.status === 404 ? (
          <p className="notice warn" role="status">This record does not exist or was deleted.</p>
        ) : (
          <ProblemNotice problem={result.problem} title="The record could not be loaded." />
        )}
        <p>
          <a href="/records">Back to records</a>
        </p>
      </section>
    );
  }

  const record = result.data;
  const canConfirm = me.ok ? me.data.capabilities.canConfirm : true;
  const canDelete = me.ok ? me.data.capabilities.canDelete : true;
  const isCandidate = record.reviewState === 'candidate';
  const isConfirmed = record.reviewState === 'confirmed';
  const antecedentTitle = (antecedentId: string | null) =>
    antecedentId && record.supersedes?.id === antecedentId ? record.supersedes.title : null;
  const conflicts = record.timeConflicts ?? [];
  // The API lets a proposer change a candidate's evidence; on a confirmed record it asks for authority.
  const canChangeEvidence = isCandidate || (isConfirmed && canConfirm);
  // The sources this record already cites, once each: the likeliest place for the next passage.
  const citedSources = [
    ...new Map(
      record.evidence.filter(e => e.available && e.sourceId).map(e => [e.sourceId as string, e.sourceTitle ?? 'Source'] as const),
    ),
  ];
  // What a competing time value can be said to come from: those sources, and any other a stored value names.
  const timeSources = conflictSourceList(citedSources.map(([sourceId, title]) => ({ id: sourceId, title })), conflicts);

  return (
    <section>
      <p className="crumbs">
        <a href="/records">Records</a>
      </p>
      <h1 data-testid="record-title">{record.title}</h1>
      <p className="row tags">
        <KindBadge kind={record.kind} />
        <ReviewBadge state={record.reviewState} />
        <StatusBadge status={record.lifecycleStatus} />
        {record.supersededBy.some(s => s.reviewState === 'confirmed') ? (
          <span className="tag warn" data-code="superseded" title="A confirmed record replaced this one">replaced</span>
        ) : record.supersededBy.length ? (
          <span className="tag" data-code="replacement_pending" title="A replacement is awaiting review">replacement awaiting review</span>
        ) : null}
        <AiBadge allowed={record.aiAllowed} />
        <span className="hint">version {record.versionNo}</span>
      </p>
      <PageNotice notice={sp.notice} />
      {record.reviewState === 'rejected' ? (
        <p className="notice danger" role="status">
          Rejected {formatTime(record.rejectedAt)}
          {record.rejectionReason ? `: ${record.rejectionReason}` : ''}
        </p>
      ) : null}
      {record.body ? <div className="record-body">{record.body}</div> : <p className="muted">No body text.</p>}

      <div className="grid-2 side-by-side">
        <div className="card" data-testid="attribution-block">
          <h2>Who said it</h2>
          <p className="hint">Where the statement came from. Saying something is not confirming it.</p>
          <dl className="pairs">
            <dt>Said by</dt>
            <dd>{record.statedByDisplayName ?? <span className="tag warn" data-code="unknown">not recorded</span>}</dd>
            <dt>In the role of</dt>
            <dd>
              <CodeTag terms={statedRoleTerms} code={record.statedRole} testId="stated-role" />
            </dd>
            <dt>How it was captured</dt>
            <dd>
              <CodeTag terms={statementModeTerms} code={record.statementMode} testId="statement-mode" />
            </dd>
          </dl>
        </div>
        <div className="card" data-testid="approval-block">
          <h2>Who confirmed it</h2>
          <p className="hint">Who confirmed it, with what authority, and which earlier record it replaced.</p>
          {record.approvals.length === 0 ? (
            <p data-testid="approval-summary">
              <strong>Not confirmed.</strong>{' '}
              {isCandidate ? 'It is awaiting review until a person with authority confirms it. Exports and agents treat it as unconfirmed.' : null}
            </p>
          ) : (
            <ul className="plain">
              {record.approvals.map(a => {
                const replacedTitle = antecedentTitle(a.antecedentRecordId);
                return (
                  <li key={a.id} data-testid="approval-summary">
                    Confirmed by <strong>{a.approvedByDisplayName}</strong> with{' '}
                    <strong data-code={a.authority} title={codeTitle(authorityTerms, a.authority)}>{labelOf(authorityTerms, a.authority)}</strong> authority at{' '}
                    <time dateTime={a.approvedAt}>{formatTime(a.approvedAt)}</time>
                    {a.antecedentRecordId ? (
                      <>
                        , replacing{' '}
                        <a href={`/records/${a.antecedentRecordId}`}>{replacedTitle ?? `record …${shortId(a.antecedentRecordId)}`}</a>
                      </>
                    ) : (
                      ', replacing no earlier record'
                    )}
                    .{a.note ? <div className="hint">Note: {a.note}</div> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <h2>Times</h2>
      <dl className="meta">
        <div>
          <dt>Saved in POII</dt>
          <dd>{formatTime(record.recordedAt)}</dd>
        </div>
        <div>
          <dt>True from (effective)</dt>
          <dd data-testid="time-effective">
            <TimeValue value={record.effectiveAt} status={record.effectiveAtStatus} conflicts={conflictsFor('effective', conflicts)} sources={timeSources} />
          </dd>
        </div>
        <div>
          <dt>Seen in practice (observed)</dt>
          <dd data-testid="time-observed">
            <TimeValue value={record.observedAt} status={record.observedAtStatus} conflicts={conflictsFor('observed', conflicts)} sources={timeSources} />
          </dd>
        </div>
      </dl>

      <h2>Evidence</h2>
      <ul className="evidence" data-testid="evidence-list">
        {record.evidence.map(e => (
          <li key={e.id} className={e.available ? '' : 'unavailable'}>
            <div className="row tags">
              <CodeTag terms={evidenceRoleTerms} code={e.role} testId="evidence-role" />
              <AnchorBadge result={e.anchorResult} />
              {e.available ? null : <span className="tag danger" data-code="unavailable">source deleted</span>}
              {e.sourceAiAllowed === false ? <AiBadge allowed={false} /> : null}
            </div>
            {e.available && e.sourceId ? (
              <a href={spanHref(e.sourceId, e.revisionId ?? e.locator.revisionId, e.locator.startChar, e.locator.endChar)} data-testid="evidence-link">
                {e.sourceTitle ?? 'Source'}, revision {e.revisionNo ?? '?'}, lines {e.locator.startLine}–{e.locator.endLine}
              </a>
            ) : (
              <span>
                {e.sourceTitle ?? 'The source'} was deleted, so this passage can no longer be shown. Original source id{' '}
                <span className="mono">{e.originalSourceId}</span>.
              </span>
            )}
            {e.available ? <blockquote>{e.locator.excerpt}</blockquote> : null}
            {canChangeEvidence && record.evidence.length > 1 ? (
              <ActionForm action={removeEvidenceAction} aria-label="Remove citation" testId="remove-evidence">
                <input type="hidden" name="recordId" value={record.id} />
                <input type="hidden" name="evidenceId" value={e.id} />
                <SubmitButton className="secondary">Remove this passage</SubmitButton>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
      {canChangeEvidence ? (
        <div className="card" data-testid="cite-another">
          <h3>Cite another passage</h3>
          <p className="hint">
            A record can quote more than one passage. Open the source that holds it, select the text, and add it to this record.
            {isConfirmed ? ' The record stays confirmed; the change is kept in its history.' : ''}
          </p>
          <ul className="compact">
            {citedSources.map(([sourceId, title]) => (
              <li key={sourceId}>
                <a href={`/sources/${sourceId}?addTo=${record.id}#add-evidence`}>{title}</a>
              </li>
            ))}
            <li>
              <a href={`/sources?addTo=${record.id}`}>Another source…</a>
            </li>
          </ul>
        </div>
      ) : null}

      <h2>Replacements</h2>
      <dl className="pairs" data-testid="supersession">
        <dt>Replaces</dt>
        <dd>
          {record.supersedes ? (
            <>
              <a href={`/records/${record.supersedes.id}`}>{record.supersedes.title}</a> <ReviewBadge state={record.supersedes.reviewState} />
            </>
          ) : (
            'no earlier record'
          )}
        </dd>
        <dt>Replaced by</dt>
        <dd>
          {record.supersededBy.length ? (
            <ol className="compact">
              {record.supersededBy.map(s => (
                <li key={s.id}>
                  <a href={`/records/${s.id}`}>{s.title}</a> <ReviewBadge state={s.reviewState} />
                </li>
              ))}
            </ol>
          ) : (
            'nothing yet'
          )}
        </dd>
      </dl>

      <h2>Actions</h2>
      {!me.ok ? <ProblemNotice problem={me.problem} title="POII could not check what you are allowed to do." /> : null}
      <div className="grid-2">
        {isCandidate && canConfirm ? (
          <div className="card">
            <h3>Confirm</h3>
            <p data-testid="antecedent-preview">
              {record.supersedes ? (
                <>
                  Confirming records that this replaces <a href={`/records/${record.supersedes.id}`}>{record.supersedes.title}</a>, which then stops being current.
                </>
              ) : (
                'Confirming replaces no earlier record.'
              )}
            </p>
            {me.ok ? (
              <p className="hint">
                You confirm as {me.data.actor.displayName}
                {me.data.actor.authority ? ` with ${labelOf(authorityTerms, me.data.actor.authority)} authority` : ''}. Your name and the time are recorded.
              </p>
            ) : null}
            <ActionForm action={confirmRecordAction} aria-label="Confirm record">
              <input type="hidden" name="recordId" value={record.id} />
              <label htmlFor="confirm-note">Note (optional)</label>
              <input id="confirm-note" name="note" maxLength={2000} />
              <SubmitButton>Confirm</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {isCandidate && canConfirm ? (
          <div className="card">
            <h3>Reject</h3>
            <p className="hint">The record is kept for history with your reason. It cannot be confirmed afterwards.</p>
            <ActionForm action={rejectRecordAction} aria-label="Reject record">
              <input type="hidden" name="recordId" value={record.id} />
              <label htmlFor="reject-reason">Reason</label>
              <input id="reject-reason" name="reason" required maxLength={2000} />
              <SubmitButton className="secondary">Reject</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {record.reviewState !== 'rejected' ? (
          <div className="card">
            <h3>Change stage</h3>
            <p className="hint">Where it stands now. Allowed on confirmed records too; the change is kept in the history.</p>
            <ActionForm action={setStatusAction} aria-label="Change stage">
              <input type="hidden" name="recordId" value={record.id} />
              <label htmlFor="status-status">Stage</label>
              <select id="status-status" name="lifecycleStatus" defaultValue={record.lifecycleStatus}>
                {lifecycleStatuses.map(s => (
                  <option key={s} value={s}>{labelOf(lifecycleStatusTerms, s)}</option>
                ))}
              </select>
              <div className="inline-fields">
                <div>
                  <label htmlFor="status-obs-status">Time seen in practice</label>
                  <select id="status-obs-status" name="observedAtStatus" defaultValue={record.observedAtStatus === 'conflicting' ? 'unknown' : record.observedAtStatus}>
                    <option value="known">{labelOf(timeStatusTerms, 'known')}</option>
                    <option value="unknown">{labelOf(timeStatusTerms, 'unknown')}</option>
                    <option value="not_applicable">{labelOf(timeStatusTerms, 'not_applicable')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="status-obs-at">Seen at (UTC), if known</label>
                  <input id="status-obs-at" name="observedAt" type="datetime-local" defaultValue={inputFromIso(record.observedAt)} />
                </div>
              </div>
              <label htmlFor="status-note">Note (optional)</label>
              <input id="status-note" name="note" maxLength={2000} />
              <SubmitButton className="secondary">Set stage</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {record.reviewState !== 'rejected' ? (
          <div className="card">
            <h3>Replace with a new version</h3>
            <p className="hint">
              Write a new record, starting from this one&apos;s evidence. It is saved for review, and once confirmed it replaces this
              record. Until then this record stays current, unchanged.
            </p>
            <a className="button secondary" href={`/records/${record.id}/supersede`}>Write a replacement…</a>
          </div>
        ) : null}
      </div>

      {record.reviewState !== 'rejected' ? (
        <details className="card edit" open={false}>
          <summary>
            <strong>Edit</strong>
            {isConfirmed ? ' (stage and times only)' : ''}
          </summary>
          {isConfirmed ? (
            <p className="hint">
              A confirmed record keeps its title, text, kind and who said it, so the confirmation still means what was confirmed.
              To change those, replace it with a new version. Its stage and times can still change.
            </p>
          ) : null}
          <ActionForm action={updateRecordAction} aria-label="Edit record">
            <input type="hidden" name="recordId" value={record.id} />
            {isConfirmed ? (
              <>
                <label htmlFor="edit-status">Stage</label>
                <select id="edit-status" name="lifecycleStatus" defaultValue={record.lifecycleStatus}>
                  {lifecycleStatuses.map(s => (
                    <option key={s} value={s}>{labelOf(lifecycleStatusTerms, s)}</option>
                  ))}
                </select>
                <TimeInputs field="effective" idPrefix="edit" status={record.effectiveAtStatus} value={record.effectiveAt} conflicts={conflicts} sources={timeSources} />
                <TimeInputs field="observed" idPrefix="edit" status={record.observedAtStatus} value={record.observedAt} conflicts={conflicts} sources={timeSources} />
              </>
            ) : (
              <RecordFields idPrefix="edit" actors={actors.ok ? actors.data : []} defaults={{ ...record, timeConflicts: conflicts }} conflictSources={timeSources} />
            )}
            <label htmlFor="edit-note">Change note (optional)</label>
            <input id="edit-note" name="note" maxLength={2000} />
            <SubmitButton>Save changes</SubmitButton>
          </ActionForm>
        </details>
      ) : null}

      <details className="card" data-testid="technical-details">
        <summary>Technical details (codes used by the API, exports and agents)</summary>
        <dl className="pairs mono">
          <dt>id</dt>
          <dd>{record.id}</dd>
          <dt>kind</dt>
          <dd>{record.kind}</dd>
          <dt>reviewState</dt>
          <dd>{record.reviewState}</dd>
          <dt>lifecycleStatus</dt>
          <dd>{record.lifecycleStatus}</dd>
          <dt>statedRole</dt>
          <dd>{record.statedRole}</dd>
          <dt>statementMode</dt>
          <dd>{record.statementMode}</dd>
          <dt>effectiveAtStatus</dt>
          <dd>{record.effectiveAtStatus}</dd>
          <dt>observedAtStatus</dt>
          <dd>{record.observedAtStatus}</dd>
          <dt>aiAllowed</dt>
          <dd>{String(record.aiAllowed)}</dd>
          <dt>supersedesRecordId</dt>
          <dd>{record.supersedes?.id ?? 'null'}</dd>
          <dt>versionNo</dt>
          <dd>{record.versionNo}</dd>
        </dl>
        <p className="hint">
          What each code means is in the <a href="/glossary">glossary</a>.
        </p>
      </details>

      <h2>History</h2>
      <div className="table-wrap">
        <table data-testid="versions">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Change</th>
              <th scope="col">By</th>
              <th scope="col">At</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {record.versions
              .slice()
              .sort((a, b) => b.versionNo - a.versionNo)
              .map(v => (
                <tr key={v.versionNo}>
                  <td>{v.versionNo}</td>
                  <td data-code={v.changeKind} title={codeTitle(changeKindTerms, v.changeKind)}>{labelOf(changeKindTerms, v.changeKind)}</td>
                  <td>{v.changedByDisplayName}</td>
                  <td className="nowrap">{formatTime(v.changedAt)}</td>
                  <td>
                    {v.note ?? ''}
                    <details>
                      <summary className="hint">full data of this version</summary>
                      <pre className="snapshot">{JSON.stringify(v.snapshot, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {canDelete ? (
        <details className="card danger-zone">
          <summary>
            <strong>Delete this record</strong>
          </summary>
          <p className="hint">
            The record and its links to evidence are removed for good; this cannot be undone. The sources stay. POII refuses
            while a confirmed record names this one as the record it replaced, so the history stays intact.
          </p>
          <ActionForm action={deleteRecordAction} aria-label="Delete record">
            <input type="hidden" name="recordId" value={record.id} />
            <label className="check">
              <input type="checkbox" name="confirmDelete" required /> Yes, delete this record
            </label>
            <SubmitButton className="danger">Delete record</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
