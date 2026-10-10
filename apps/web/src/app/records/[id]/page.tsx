import type { Metadata } from 'next';
import type { ActorView, MeResponse, RecordDetail } from '@poii/contracts';
import { lifecycleStatuses } from '@poii/contracts';
import {
  confirmRecordAction,
  deleteRecordAction,
  rejectRecordAction,
  setStatusAction,
  updateRecordAction,
} from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { AiBadge, AnchorBadge, Attribution, KindBadge, ReviewBadge, StatusBadge, TimeValue } from '@/components/Badges';
import { PageNotice } from '@/components/PageNotice';
import { ProblemNotice } from '@/components/ProblemNotice';
import { RecordFields, TimeInputs } from '@/components/RecordFields';
import { apiTry } from '@/lib/api';
import { conflictsFor, formatTime, humanize, inputFromIso } from '@/lib/format';
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
        {record.supersededBy.length ? <span className="tag warn">superseded</span> : null}
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
          <h2>Attribution</h2>
          <p className="hint">Who said it. This is not approval.</p>
          <dl className="pairs">
            <dt>Stated by</dt>
            <dd>{record.statedByDisplayName ?? <span className="tag warn">unknown</span>}</dd>
            <dt>Role</dt>
            <dd>{humanize(record.statedRole)}</dd>
            <dt>Mode</dt>
            <dd>{humanize(record.statementMode)}</dd>
          </dl>
        </div>
        <div className="card" data-testid="approval-block">
          <h2>Approval</h2>
          <p className="hint">Who confirmed it, with what authority, replacing what.</p>
          {record.approvals.length === 0 ? (
            <p data-testid="approval-summary">
              <strong>Not approved.</strong>{' '}
              {isCandidate ? 'This is a candidate until a person with authority confirms it.' : null}
            </p>
          ) : (
            <ul className="plain">
              {record.approvals.map(a => {
                const replacedTitle = antecedentTitle(a.antecedentRecordId);
                return (
                  <li key={a.id} data-testid="approval-summary">
                    Approved by <strong>{a.approvedByDisplayName}</strong> with authority <strong>{a.authority}</strong> at{' '}
                    <time dateTime={a.approvedAt}>{formatTime(a.approvedAt)}</time>
                    {a.antecedentRecordId ? (
                      <>
                        , replacing{' '}
                        <a href={`/records/${a.antecedentRecordId}`}>{replacedTitle ?? `record …${shortId(a.antecedentRecordId)}`}</a>
                      </>
                    ) : (
                      ', replacing nothing'
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
          <dt>Recorded</dt>
          <dd>{formatTime(record.recordedAt)}</dd>
        </div>
        <div>
          <dt>Effective</dt>
          <dd data-testid="time-effective">
            <TimeValue value={record.effectiveAt} status={record.effectiveAtStatus} conflicts={conflictsFor('effective', conflicts)} />
          </dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd data-testid="time-observed">
            <TimeValue value={record.observedAt} status={record.observedAtStatus} conflicts={conflictsFor('observed', conflicts)} />
          </dd>
        </div>
      </dl>

      <h2>Evidence</h2>
      <ul className="evidence" data-testid="evidence-list">
        {record.evidence.map(e => (
          <li key={e.id} className={e.available ? '' : 'unavailable'}>
            <div className="row tags">
              <span className="tag">{e.role}</span>
              <AnchorBadge result={e.anchorResult} />
              {e.available ? <span className="tag ok">available</span> : <span className="tag danger">unavailable</span>}
              {e.sourceAiAllowed === false ? <AiBadge allowed={false} /> : null}
            </div>
            {e.available && e.sourceId ? (
              <a href={spanHref(e.sourceId, e.revisionId ?? e.locator.revisionId, e.locator.startChar, e.locator.endChar)} data-testid="evidence-link">
                {e.sourceTitle ?? 'Source'}, revision {e.revisionNo ?? '?'}, lines {e.locator.startLine}–{e.locator.endLine}
              </a>
            ) : (
              <span>
                {e.sourceTitle ?? 'Source'} is unavailable (deleted). Original source id{' '}
                <span className="mono">{e.originalSourceId}</span>.
              </span>
            )}
            {e.available ? <blockquote>{e.locator.excerpt}</blockquote> : null}
          </li>
        ))}
      </ul>

      <h2>Supersession</h2>
      <dl className="pairs" data-testid="supersession">
        <dt>Supersedes</dt>
        <dd>
          {record.supersedes ? (
            <>
              <a href={`/records/${record.supersedes.id}`}>{record.supersedes.title}</a> <ReviewBadge state={record.supersedes.reviewState} />
            </>
          ) : (
            'nothing'
          )}
        </dd>
        <dt>Superseded by</dt>
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
            'nothing confirmed'
          )}
        </dd>
      </dl>

      <h2>Actions</h2>
      {!me.ok ? <ProblemNotice problem={me.problem} title="Your capabilities could not be loaded." /> : null}
      <div className="grid-2">
        {isCandidate && canConfirm ? (
          <div className="card">
            <h3>Confirm</h3>
            <p data-testid="antecedent-preview">
              {record.supersedes ? (
                <>
                  The approval will record that this replaces <a href={`/records/${record.supersedes.id}`}>{record.supersedes.title}</a>.
                </>
              ) : (
                'The approval will replace nothing (no antecedent).'
              )}
            </p>
            {me.ok ? (
              <p className="hint">
                You confirm as {me.data.actor.displayName}
                {me.data.actor.authority ? ` with authority ${me.data.actor.authority}` : ''}.
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
            <h3>Set lifecycle status</h3>
            <ActionForm action={setStatusAction} aria-label="Set status">
              <input type="hidden" name="recordId" value={record.id} />
              <label htmlFor="status-status">Status</label>
              <select id="status-status" name="lifecycleStatus" defaultValue={record.lifecycleStatus}>
                {lifecycleStatuses.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <div className="inline-fields">
                <div>
                  <label htmlFor="status-obs-status">Observed time status</label>
                  <select id="status-obs-status" name="observedAtStatus" defaultValue={record.observedAtStatus === 'conflicting' ? 'unknown' : record.observedAtStatus}>
                    <option value="known">known</option>
                    <option value="unknown">unknown</option>
                    <option value="not_applicable">not applicable</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="status-obs-at">Observed at (UTC)</label>
                  <input id="status-obs-at" name="observedAt" type="datetime-local" defaultValue={inputFromIso(record.observedAt)} />
                </div>
              </div>
              <label htmlFor="status-note">Note (optional)</label>
              <input id="status-note" name="note" maxLength={2000} />
              <SubmitButton className="secondary">Set status</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {record.reviewState !== 'rejected' ? (
          <div className="card">
            <h3>Supersede</h3>
            <p className="hint">
              Start a new candidate with the same evidence that replaces this record once confirmed. Until then this record stays as
              it is.
            </p>
            <a className="button secondary" href={`/records/${record.id}/supersede`}>Supersede…</a>
          </div>
        ) : null}
      </div>

      {record.reviewState !== 'rejected' ? (
        <details className="card edit" open={false}>
          <summary>
            <strong>Edit</strong>
            {isConfirmed ? ' (status and times only)' : ''}
          </summary>
          {isConfirmed ? (
            <p className="hint">
              A confirmed record keeps its title, body, kind and attribution so its approval stays meaningful. To change those,
              supersede it. Lifecycle status and times can still change.
            </p>
          ) : null}
          <ActionForm action={updateRecordAction} aria-label="Edit record">
            <input type="hidden" name="recordId" value={record.id} />
            {isConfirmed ? (
              <>
                <label htmlFor="edit-status">Lifecycle status</label>
                <select id="edit-status" name="lifecycleStatus" defaultValue={record.lifecycleStatus}>
                  {lifecycleStatuses.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <TimeInputs field="effective" idPrefix="edit" status={record.effectiveAtStatus} value={record.effectiveAt} conflicts={conflicts} />
                <TimeInputs field="observed" idPrefix="edit" status={record.observedAtStatus} value={record.observedAt} conflicts={conflicts} />
              </>
            ) : (
              <RecordFields idPrefix="edit" actors={actors.ok ? actors.data : []} defaults={{ ...record, timeConflicts: conflicts }} />
            )}
            <label htmlFor="edit-note">Change note (optional)</label>
            <input id="edit-note" name="note" maxLength={2000} />
            <SubmitButton>Save changes</SubmitButton>
          </ActionForm>
        </details>
      ) : null}

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
                  <td>{v.changeKind}</td>
                  <td>{v.changedByDisplayName}</td>
                  <td className="nowrap">{formatTime(v.changedAt)}</td>
                  <td>
                    {v.note ?? ''}
                    <details>
                      <summary className="hint">snapshot</summary>
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
            The record and its evidence links are removed. Deletion is refused while a confirmed successor names it as the record
            it replaced.
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
