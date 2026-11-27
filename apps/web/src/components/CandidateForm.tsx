'use client';

import { useState } from 'react';
import type { ActorView } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { titleFromExcerpt, type Span } from '@/lib/offsets';
import { labelOf, recordKindTerms } from '@/lib/labels';
import { ActionForm, SubmitButton } from './ActionForm';
import { RecordFields } from './RecordFields';
import { SpanFields, spanSummary, useSpanSelection, type EvidenceRoleValue } from './SpanPicker';

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  sourceId: string;
  sourceTitle: string;
  revisionId: string;
  content: string;
  actors: ActorView[];
  supersedable: { id: string; title: string; kind: string }[];
  initialSpan: Span | null;
  preId?: string;
};

type KeptSpan = Span & { role: EvidenceRoleValue };

/**
 * "Create candidate from selection": select text in the source and the offsets, excerpt and a title prefill
 * follow. A candidate can cite several passages of this source: keep a span, then select the next one. Without
 * JavaScript the offset inputs can be typed by hand and the form still submits (with one span).
 */
export function CandidateForm({ action, sourceId, sourceTitle, revisionId, content, actors, supersedable, initialSpan, preId = 'source-text' }: Props) {
  const [title, setTitle] = useState(initialSpan ? titleFromExcerpt(content.slice(initialSpan.start, initialSpan.end)) : '');
  const [kept, setKept] = useState<KeptSpan[]>([]);
  const selection = useSpanSelection({
    content,
    initialSpan,
    preId,
    // The title follows the first passage only; later ones must not overwrite it.
    onPick: span => {
      if (kept.length === 0) setTitle(titleFromExcerpt(content.slice(span.start, span.end)));
    },
  });
  const { picked, role, enhanced } = selection;

  const keep = () => {
    if (!picked) return;
    setKept(list => (list.some(s => s.start === picked.start && s.end === picked.end) ? list : [...list, { ...picked, role }]));
    selection.clear();
  };

  return (
    <ActionForm action={action} className="card candidate-form" aria-label="New record from the selected text" testId="candidate-form">
      <h2 id="candidate">New record from the selected text</h2>
      <p className="hint">
        {enhanced
          ? 'Select the passage in the source above, then press "Use current selection". The quote and a title fill in here. The record is saved awaiting review.'
          : 'Enter the start and end positions of the passage, in characters (the start and end values of a link to it).'}
      </p>
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      {kept.length ? (
        <fieldset data-testid="kept-spans">
          <legend>Passages kept for this record</legend>
          <ul className="plain">
            {kept.map(s => {
              const excerpt = content.slice(s.start, s.end);
              return (
                <li key={`${s.start}-${s.end}`} className="excerpt">
                  {/* Same wire format as the supersede form: "sourceId|revisionId|start|end|role". */}
                  <input type="hidden" name="keepEvidence" value={[sourceId, revisionId, s.start, s.end, s.role].join('|')} />
                  <span className="hint">
                    {spanSummary(content, s)}, {s.role === 'primary' ? 'main evidence' : 'supporting'}
                  </span>
                  <blockquote>{excerpt.length > 300 ? `${excerpt.slice(0, 300)}…` : excerpt}</blockquote>
                  <button type="button" className="secondary" onClick={() => setKept(list => list.filter(k => k !== s))}>
                    Drop this passage
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}
      <SpanFields
        idPrefix="cand"
        legend={kept.length ? 'Another quoted passage (optional)' : 'Quoted passage'}
        content={content}
        selection={selection}
        required={kept.length === 0}
      >
        <button type="button" className="secondary" onClick={keep} disabled={!picked} data-testid="keep-span">
          Keep this passage and select another
        </button>
      </SpanFields>
      {enhanced && kept.length === 0 ? (
        <p className="hint">A record can quote more than one passage of this source: keep one, then select the next.</p>
      ) : null}
      <RecordFields
        idPrefix="cand"
        actors={actors}
        defaults={{ kind: '' }}
        title={title}
        onTitleChange={setTitle}
        // A new candidate cites this source, so this is the one source a competing time value can name here.
        conflictSources={[{ id: sourceId, title: sourceTitle }]}
      />
      {supersedable.length ? (
        <>
          <label htmlFor="cand-supersedes">Replaces an earlier record (optional)</label>
          <select id="cand-supersedes" name="supersedesRecordId" defaultValue="">
            <option value="">No, this is new</option>
            {supersedable.map(r => (
              <option key={r.id} value={r.id}>
                {labelOf(recordKindTerms, r.kind)}: {r.title.length > 90 ? `${r.title.slice(0, 89)}…` : r.title}
              </option>
            ))}
          </select>
          <p className="hint">The earlier record stays current until this one is confirmed.</p>
        </>
      ) : null}
      <div className="row actions">
        <SubmitButton>Save for review</SubmitButton>
      </div>
    </ActionForm>
  );
}
