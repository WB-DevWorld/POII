'use client';

import type { ActionState } from '@/lib/action-state';
import type { Span } from '@/lib/offsets';
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
      <h2 id="add-evidence">Cite a passage for an existing record</h2>
      <p data-testid="add-evidence-record">
        Record: <a href={`/records/${record.id}`}>{record.title}</a>{' '}
        <span className="tag">{record.kind}</span> <span className="tag">{record.reviewState}</span>
      </p>
      <p className="hint">
        {selection.enhanced
          ? 'Select the passage in the source above; the span fills in here. The record keeps the passages it already cites.'
          : 'Enter the start and end character offsets of the passage (the deep-link start and end values).'}
      </p>
      <input type="hidden" name="recordId" value={record.id} />
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <SpanFields idPrefix="ev" legend="Passage to cite" content={content} selection={selection} excerptTestId="add-evidence-excerpt" />
      <div className="row actions">
        <SubmitButton>Add as evidence</SubmitButton>
        <a className="button secondary" href={`/records/${record.id}`}>Back to the record</a>
      </div>
    </ActionForm>
  );
}
