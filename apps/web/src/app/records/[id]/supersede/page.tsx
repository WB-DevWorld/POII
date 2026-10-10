import type { Metadata } from 'next';
import type { ActorView, RecordDetail, SourceView } from '@poii/contracts';
import { supersedeRecordAction } from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { RecordFields } from '@/components/RecordFields';
import { apiTry } from '@/lib/api';

export const metadata: Metadata = { title: 'Supersede record' };

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
        <h1>Supersede record</h1>
        <ProblemNotice problem={result.problem} title="The record could not be loaded." />
      </section>
    );
  }
  const record = result.data;
  const available = record.evidence.filter(e => e.available && e.sourceId);
  return (
    <section>
      <p className="crumbs">
        <a href={`/records/${record.id}`}>Back to the record</a>
      </p>
      <h1>Supersede: {record.title}</h1>
      <p className="lede">
        This creates a new <strong>candidate</strong> linked to the old record. The old record stays as it is until the new one
        is confirmed; then it drops out of the current view and the approval names it as the antecedent.
      </p>
      <ActionForm action={supersedeRecordAction} className="card stack" aria-label="Superseding record" testId="supersede-form">
        <input type="hidden" name="recordId" value={record.id} />
        <fieldset>
          <legend>Evidence</legend>
          {available.length === 0 ? <p className="hint">The old record has no available evidence; add a span below.</p> : null}
          {available.map(e => (
            <label key={e.id} className="check">
              <input
                type="checkbox"
                name="keepEvidence"
                defaultChecked
                value={[e.sourceId, e.revisionId ?? e.locator.revisionId, e.locator.startChar, e.locator.endChar, e.role].join('|')}
              />{' '}
              {e.sourceTitle ?? 'Source'} (lines {e.locator.startLine}–{e.locator.endLine}, {e.role}):{' '}
              <span className="muted">{e.locator.excerpt.length > 160 ? `${e.locator.excerpt.slice(0, 159)}…` : e.locator.excerpt}</span>
            </label>
          ))}
          <details>
            <summary>Add another span</summary>
            <p className="hint">Offsets are characters into the source&apos;s current revision; select text on the source page to see them.</p>
            <label htmlFor="sup-source">Source</label>
            <select id="sup-source" name="sourceId" defaultValue="">
              <option value="">None</option>
              {(sources.ok ? sources.data : []).map(s => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <div className="inline-fields">
              <div>
                <label htmlFor="sup-start">Start offset</label>
                <input id="sup-start" name="startChar" inputMode="numeric" pattern="[0-9]*" />
              </div>
              <div>
                <label htmlFor="sup-end">End offset</label>
                <input id="sup-end" name="endChar" inputMode="numeric" pattern="[0-9]*" />
              </div>
              <div>
                <label htmlFor="sup-role">Role</label>
                <select id="sup-role" name="evidenceRole" defaultValue="primary">
                  <option value="primary">primary</option>
                  <option value="supporting">supporting</option>
                </select>
              </div>
            </div>
          </details>
        </fieldset>
        <RecordFields idPrefix="sup" actors={actors.ok ? actors.data : []} defaults={{ ...record, timeConflicts: record.timeConflicts }} />
        <div className="row actions">
          <SubmitButton>Create superseding candidate</SubmitButton>
          <a className="button secondary" href={`/records/${record.id}`}>Cancel</a>
        </div>
      </ActionForm>
    </section>
  );
}
