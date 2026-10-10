import type { Metadata } from 'next';
import type { ActorView, RecordSummary, RevisionView, SourceDetail } from '@poii/contracts';
import {
  addRevisionAction,
  createRecordAction,
  deleteSourceAction,
  updateSourceAction,
} from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { AiBadge, Attribution, KindBadge, ReviewBadge, StatusBadge } from '@/components/Badges';
import { CandidateForm } from '@/components/CandidateForm';
import { PageNotice } from '@/components/PageNotice';
import { ProblemNotice } from '@/components/ProblemNotice';
import { SourceText } from '@/components/SourceText';
import { apiTry } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';
import { lineOfOffset, parseSpanParams } from '@/lib/offsets';

export const metadata: Metadata = { title: 'Source' };

type Params = Promise<{ id: string }>;

export default async function SourcePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const [detail, citing, actors, confirmed] = await Promise.all([
    apiTry<SourceDetail>(`/v1/sources/${encodeURIComponent(id)}`),
    apiTry<RecordSummary[]>(`/v1/sources/${encodeURIComponent(id)}/records`),
    apiTry<ActorView[]>('/v1/actors'),
    apiTry<RecordSummary[]>('/v1/records?reviewState=confirmed&limit=200'),
  ]);

  if (!detail.ok) {
    const gone = detail.problem.status === 404;
    return (
      <section>
        <h1>Source</h1>
        <PageNotice notice={sp.notice} />
        {gone ? (
          <p className="notice warn" role="status">
            This source is not available. It may have been deleted; records that cited it keep their history and list the
            evidence as unavailable.
          </p>
        ) : (
          <ProblemNotice problem={detail.problem} title="The source could not be loaded." />
        )}
        <p>
          <a href="/sources">Back to sources</a>
        </p>
      </section>
    );
  }

  const source = detail.data;
  const requestedRevision = first(sp.revision);
  let revision: RevisionView = source.currentRevision;
  let revisionProblem = null;
  if (requestedRevision && requestedRevision !== source.currentRevision.id) {
    const other = await apiTry<RevisionView>(`/v1/sources/${encodeURIComponent(id)}/revisions/${encodeURIComponent(requestedRevision)}`);
    if (other.ok) revision = other.data;
    else revisionProblem = other.problem;
  }
  const isCurrent = revision.id === source.currentRevision.id;
  const content = revision.contentText;
  const span = parseSpanParams(first(sp.start), first(sp.end), content.length);
  const spanRequested = first(sp.start) !== undefined || first(sp.end) !== undefined;
  const supersedable = confirmed.ok ? confirmed.data.filter(r => !r.supersededByRecordId).map(r => ({ id: r.id, title: r.title, kind: r.kind })) : [];
  const originEntries = Object.entries(source.origin ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <section>
      <p className="crumbs">
        <a href="/sources">Sources</a>
      </p>
      <h1>{source.title}</h1>
      <p className="row tags">
        <span className="tag">{source.kind}</span>
        <AiBadge allowed={source.aiAllowed} />
        {source.archivedAt ? <span className="tag warn">archived {formatTime(source.archivedAt)}</span> : null}
      </p>
      <PageNotice notice={sp.notice} />

      <dl className="meta">
        <div>
          <dt>Created</dt>
          <dd>{formatTime(source.createdAt)}</dd>
        </div>
        <div>
          <dt>Media type</dt>
          <dd>{source.mediaType}</dd>
        </div>
        <div>
          <dt>Revisions</dt>
          <dd>{source.revisionCount}</dd>
        </div>
        <div>
          <dt>Records citing it</dt>
          <dd>{source.recordCount}</dd>
        </div>
        {originEntries.map(([key, value]) => (
          <div key={key}>
            <dt>Origin {key}</dt>
            <dd className="break">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>

      <h2>Original text</h2>
      <nav className="revisions" aria-label="Revisions">
        <span className="muted">Revision:</span>
        {source.revisions
          .slice()
          .sort((a, b) => b.revisionNo - a.revisionNo)
          .map(r => (
            <a
              key={r.id}
              href={r.id === source.currentRevision.id ? `/sources/${source.id}` : `/sources/${source.id}?revision=${r.id}`}
              aria-current={r.id === revision.id ? 'page' : undefined}
              title={`${formatTime(r.createdAt)}${r.note ? ` · ${r.note}` : ''}`}
            >
              {r.revisionNo}
              {r.id === source.currentRevision.id ? ' (current)' : ''}
            </a>
          ))}
      </nav>
      {revisionProblem ? <ProblemNotice problem={revisionProblem} title="That revision could not be loaded; showing the current one." /> : null}
      {!isCurrent ? (
        <p className="notice warn" role="status">
          You are viewing revision {revision.revisionNo} of {source.revisionCount}, not the current one.
        </p>
      ) : null}
      <p className="hint mono break">
        {revision.lineCount} lines · {revision.byteLength} bytes · sha256 {revision.contentSha256.slice(0, 16)}…
        {revision.note ? ` · ${revision.note}` : ''}
      </p>
      {span ? (
        <p className="notice" role="status" data-testid="span-notice">
          Highlighted span: characters {span.start}–{span.end}, line {lineOfOffset(content, span.start)}.{' '}
          <a href="#span">Jump to the span</a>
        </p>
      ) : spanRequested ? (
        <p className="notice warn" role="status">
          The requested span is outside this revision. It may come from another revision of this source.
        </p>
      ) : null}
      <SourceText content={content} revisionId={revision.id} highlight={span} />

      {source.archivedAt ? (
        <p className="notice warn">This source is archived. Unarchive it before citing it in new candidates.</p>
      ) : null}
      {/* #13 AI */}
      <p className="hint">
        <a href={`/sources/${source.id}/ai${span ? `?start=${span.start}&end=${span.end}` : ''}`} data-testid="ai-link">
          AI-assisted extraction{source.aiAllowed ? '' : ' (unavailable: never send to AI)'}
        </a>
      </p>
      <CandidateForm
        action={createRecordAction}
        sourceId={source.id}
        revisionId={revision.id}
        content={content}
        actors={actors.ok ? actors.data : []}
        supersedable={supersedable}
        initialSpan={span}
      />
      {!actors.ok ? <ProblemNotice problem={actors.problem} title="People and assistants could not be loaded." /> : null}

      <h2>Records citing this source</h2>
      {!citing.ok ? (
        <ProblemNotice problem={citing.problem} title="Records could not be loaded." />
      ) : citing.data.length === 0 ? (
        <p className="muted">No records cite this source yet.</p>
      ) : (
        <ul className="record-list" data-testid="citing-records">
          {citing.data.map(r => (
            <li key={r.id}>
              <a href={`/records/${r.id}`}>{r.title}</a>
              <div className="row tags">
                <KindBadge kind={r.kind} />
                <ReviewBadge state={r.reviewState} />
                <StatusBadge status={r.lifecycleStatus} />
                <Attribution by={r.statedByDisplayName} role={r.statedRole} mode={r.statementMode} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Manage this source</h2>
      <div className="grid-2">
        <div className="card">
          <h3>Never send to AI</h3>
          <p className="hint">
            {source.aiAllowed
              ? 'This source may be sent to an AI provider when AI is on. Marking it covers every record derived from it.'
              : 'This source and every record derived from it are never sent to an AI provider.'}
          </p>
          <ActionForm action={updateSourceAction} aria-label="AI permission">
            <input type="hidden" name="sourceId" value={source.id} />
            <input type="hidden" name="aiAllowed" value={source.aiAllowed ? 'false' : 'true'} />
            <SubmitButton className="secondary">{source.aiAllowed ? 'Mark never send to AI' : 'Allow sending to AI'}</SubmitButton>
          </ActionForm>
        </div>
        <div className="card">
          <h3>{source.archivedAt ? 'Unarchive' : 'Archive'}</h3>
          <p className="hint">Archived sources are hidden from the default list and excluded from context packs. Nothing is deleted.</p>
          <ActionForm action={updateSourceAction} aria-label="Archive">
            <input type="hidden" name="sourceId" value={source.id} />
            <input type="hidden" name="archived" value={source.archivedAt ? 'false' : 'true'} />
            <SubmitButton className="secondary">{source.archivedAt ? 'Unarchive' : 'Archive'}</SubmitButton>
          </ActionForm>
        </div>
        <div className="card">
          <h3>Add a revision</h3>
          <ActionForm action={addRevisionAction} aria-label="Add revision">
            <input type="hidden" name="sourceId" value={source.id} />
            <label htmlFor="rev-content">New content</label>
            <textarea id="rev-content" name="content" className="short" spellCheck={false} />
            <label htmlFor="rev-file">…or upload a file</label>
            <input id="rev-file" name="file" type="file" accept=".md,.markdown,.txt,.json,text/plain,text/markdown" />
            <label htmlFor="rev-note">Note</label>
            <input id="rev-note" name="note" maxLength={2000} />
            <p className="hint">Identical content changes nothing. Existing citations are re-anchored and labelled exact, moved or lost.</p>
            <SubmitButton className="secondary">Add revision</SubmitButton>
          </ActionForm>
        </div>
        <div className="card danger-zone">
          <h3>Delete</h3>
          <p className="hint">
            Deleting removes the content and its search entries immediately. Records that cite it keep their history, but their
            evidence becomes <strong>unavailable</strong> and every later export lists it as unavailable (deleted). This cannot be
            undone.
          </p>
          <ActionForm action={deleteSourceAction} aria-label="Delete source">
            <input type="hidden" name="sourceId" value={source.id} />
            <label htmlFor="del-reason">Reason (optional)</label>
            <input id="del-reason" name="reason" maxLength={2000} />
            <label className="check">
              <input type="checkbox" name="confirmDelete" required /> I understand that derived evidence becomes unavailable
            </label>
            <SubmitButton className="danger">Delete source</SubmitButton>
          </ActionForm>
        </div>
      </div>
    </section>
  );
}
