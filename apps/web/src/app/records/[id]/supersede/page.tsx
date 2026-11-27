import type { Metadata } from 'next';
import type { ActorView, RecordDetail, SourceView } from '@poii/contracts';
import { supersedeRecordAction } from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { RecordFields } from '@/components/RecordFields';
import { apiTry } from '@/lib/api';
import { conflictSourceList } from '@/lib/format';

export const metadata: Metadata = { title: 'Replace a record' };

type Params = Promise<{ id: string }>;

export default async function SupersedePage({ params }: { params: Params }) {
  const { id } = await params;
  const [result, actors, sources] = await Promise.all([
    apiTry<RecordDetail>(`/v1/records/${encodeURIComponent(id)}`),
    apiTry<ActorView[]>('/v1/actors'),
    apiTry<SourceView[]>('/v1/sources?limit=200'),
  ]);
  if (!result.ok) {
    return (
      <section>
        <h1>Replace a record</h1>
        <ProblemNotice problem={result.problem} title="The record could not be loaded." />
      </section>
    );
  }
  const record = result.data;
  const available = record.evidence.filter(e => e.available && e.sourceId);
  // Sources a competing time value can be said to come from: what the old record cites, and what its values already name.
  const timeSources = conflictSourceList(
    available.map(e => ({ id: e.sourceId as string, title: e.sourceTitle ?? 'Source' })),
    record.timeConflicts,
  );
  return (
    <section>
      <p className="crumbs">
        <a href={`/records/${record.id}`}>Back to the record</a>
      </p>
      <h1>Replace: {record.title}</h1>
      <p className="lede">
        This saves a new record, <strong>awaiting review</strong>, linked to the old one. The old record stays current and
        unchanged until someone with authority confirms the new one. Then the old record stops being current, and the
        confirmation records which record it replaced. Nothing is deleted.
      </p>
      <ActionForm action={supersedeRecordAction} className="card stack" aria-label="Replacement record" testId="supersede-form">
        <input type="hidden" name="recordId" value={record.id} />
        <fieldset>
          <legend>Evidence to keep</legend>
          {available.length === 0 ? <p className="hint">The old record has no passage that can still be shown; add one below.</p> : null}
          {available.map(e => (
            <label key={e.id} className="check">
              <input
                type="checkbox"
                name="keepEvidence"
                defaultChecked
                value={[e.sourceId, e.revisionId ?? e.locator.revisionId, e.locator.startChar, e.locator.endChar, e.role].join('|')}
              />{' '}
              {e.sourceTitle ?? 'Source'} (lines {e.locator.startLine}–{e.locator.endLine}, {e.role === 'primary' ? 'main evidence' : 'supporting'}):{' '}
              <span className="muted">{e.locator.excerpt.length > 160 ? `${e.locator.excerpt.slice(0, 159)}…` : e.locator.excerpt}</span>
            </label>
          ))}
          <details>
            <summary>Add another passage by position</summary>
            <p className="hint">
              Positions count characters from the start of the source&apos;s current revision. Selecting text on the source page shows
              them; adding a passage from the source page is usually easier.
            </p>
            <label htmlFor="sup-source">Source</label>
            <select id="sup-source" name="sourceId" defaultValue="">
              <option value="">None</option>
              {(sources.ok ? sources.data : []).map(s => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <div className="inline-fields">
              <div>
                <label htmlFor="sup-start">Start position</label>
                <input id="sup-start" name="startChar" inputMode="numeric" pattern="[0-9]*" />
              </div>
              <div>
                <label htmlFor="sup-end">End position</label>
                <input id="sup-end" name="endChar" inputMode="numeric" pattern="[0-9]*" />
              </div>
              <div>
                <label htmlFor="sup-role">Kind of evidence</label>
                <select id="sup-role" name="evidenceRole" defaultValue="primary">
                  <option value="primary">Main evidence</option>
                  <option value="supporting">Supporting</option>
                </select>
              </div>
            </div>
          </details>
        </fieldset>
        <RecordFields idPrefix="sup" actors={actors.ok ? actors.data : []} defaults={{ ...record, timeConflicts: record.timeConflicts }} conflictSources={timeSources} />
        <div className="row actions">
          <SubmitButton>Save the replacement for review</SubmitButton>
          <a className="button secondary" href={`/records/${record.id}`}>Cancel</a>
        </div>
      </ActionForm>
    </section>
  );
}
