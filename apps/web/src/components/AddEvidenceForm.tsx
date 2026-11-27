'use client';

import type { ActionState } from '@/lib/action-state';
import type { Span } from '@/lib/offsets';
import { recordKindTerms, reviewStateTerms } from '@/lib/labels';
import { CodeTag } from './Badges';
import { ActionForm, SubmitButton } from './ActionForm';
import { SpanFields, useSpanSelection } from './SpanPicker';

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  record: { id: string; title: string; kind: string; reviewState: string };
  sourceId: string;
  revisionId: string;
  content: string;
  initialSpan: Span | null;
};

/**
 * "Cite this passage for an existing record": the same span picker as the candidate form, but the span is added
 * to a record that already exists. This is how a record comes to cite a second passage, in this source or another.
 */
export function AddEvidenceForm({ action, record, sourceId, revisionId, content, initialSpan }: Props) {
  const selection = useSpanSelection({ content, initialSpan });
  return (
    <ActionForm action={action} className="card candidate-form" aria-label="Add selection as evidence" testId="add-evidence-form">
      <h2 id="add-evidence">Add a passage to an existing record</h2>
      <p data-testid="add-evidence-record">
        Record: <a href={`/records/${record.id}`}>{record.title}</a>{' '}
        <CodeTag terms={recordKindTerms} code={record.kind} /> <CodeTag terms={reviewStateTerms} code={record.reviewState} />
      </p>
      <p className="hint">
        {selection.enhanced
          ? 'Select the passage in the source above, then press "Use current selection". The record keeps the passages it already quotes.'
          : 'Enter the start and end positions of the passage, in characters (the start and end values of a link to it).'}
      </p>
      <input type="hidden" name="recordId" value={record.id} />
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <SpanFields idPrefix="ev" legend="Passage to add" content={content} selection={selection} excerptTestId="add-evidence-excerpt" />
      <div className="row actions">
        <SubmitButton>Add as evidence</SubmitButton>
        <a className="button secondary" href={`/records/${record.id}`}>Back to the record</a>
      </div>
    </ActionForm>
  );
}
