'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ActorView } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { lineOfOffset, normalizeSpan, pointToOffset, titleFromExcerpt, trimSpan, type Span } from '@/lib/offsets';
import { ActionForm, SubmitButton } from './ActionForm';
import { RecordFields } from './RecordFields';

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  sourceId: string;
  revisionId: string;
  content: string;
  actors: ActorView[];
  supersedable: { id: string; title: string; kind: string }[];
  initialSpan: Span | null;
  preId?: string;
};

function dataNumber(el: Element | null | undefined, key: 'o' | 's' | 'e'): number | null {
  const value = (el as HTMLElement | null | undefined)?.dataset?.[key];
  return value === undefined ? null : Number(value);
}

/** Maps one DOM boundary point inside the source <pre> to a raw offset into the revision content. */
function resolvePoint(pre: HTMLElement, node: Node, offset: number, length: number): number {
  if (!pre.contains(node)) {
    // The selection runs past the <pre>: clamp to its start or end.
    return pre.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : length;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const chunk = node.parentElement?.closest('[data-o]');
    const start = dataNumber(chunk, 'o');
    if (start !== null) return pointToOffset(start, offset, node.textContent?.length ?? 0);
    const line = node.parentElement?.closest('[data-s]');
    return dataNumber(line, 's') ?? 0;
  }
  const el = node as Element;
  const child = el.childNodes[offset];
  if (child) {
    if (child.nodeType === Node.TEXT_NODE) return resolvePoint(pre, child, 0, length);
    const c = child as Element;
    const own = dataNumber(c, 'o') ?? dataNumber(c, 's');
    if (own !== null) return own;
    const inner = c.querySelector('[data-o],[data-s]');
    if (inner) return dataNumber(inner, 'o') ?? dataNumber(inner, 's') ?? 0;
  }
  // Point after the last child: the end of this element.
  const end = dataNumber(el, 'e');
  if (end !== null) return end;
  const chunkStart = dataNumber(el, 'o');
  if (chunkStart !== null) return chunkStart + (el.textContent?.length ?? 0);
  const lines = el.querySelectorAll('[data-e]');
  const last = lines[lines.length - 1];
  return dataNumber(last, 'e') ?? length;
}

/**
 * "Create candidate from selection": select text in the source and the offsets, excerpt and a title prefill
 * follow. Without JavaScript the offset inputs can be typed by hand and the form still submits.
 */
export function CandidateForm({ action, sourceId, revisionId, content, actors, supersedable, initialSpan, preId = 'source-text' }: Props) {
  const [span, setSpan] = useState<{ start: string; end: string }>({
    start: initialSpan ? String(initialSpan.start) : '',
    end: initialSpan ? String(initialSpan.end) : '',
  });
  const [title, setTitle] = useState(initialSpan ? titleFromExcerpt(content.slice(initialSpan.start, initialSpan.end)) : '');
  const [enhanced, setEnhanced] = useState(false);

  const fromSelection = useCallback(() => {
    const pre = document.getElementById(preId);
    const selection = window.getSelection();
    if (!pre || !selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(pre)) return false;
    const a = resolvePoint(pre, range.startContainer, range.startOffset, content.length);
    const b = resolvePoint(pre, range.endContainer, range.endOffset, content.length);
    const trimmedSpan = trimSpan(content, normalizeSpan(a, b, content.length));
    if (!trimmedSpan) return false;
    setSpan({ start: String(trimmedSpan.start), end: String(trimmedSpan.end) });
    setTitle(titleFromExcerpt(content.slice(trimmedSpan.start, trimmedSpan.end)));
    return true;
  }, [content, preId]);

  useEffect(() => {
    setEnhanced(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(fromSelection, 120);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [fromSelection]);

  const start = Number(span.start);
  const end = Number(span.end);
  const valid = span.start !== '' && span.end !== '' && Number.isInteger(start) && Number.isInteger(end) && end > start && end <= content.length;
  const excerpt = valid ? content.slice(start, end) : '';

  return (
    <ActionForm action={action} className="card candidate-form" aria-label="Create candidate from selection" testId="candidate-form">
      <h2 id="candidate">Create candidate from selection</h2>
      <p className="hint">
        {enhanced
          ? 'Select text in the source above; the span and a title fill in here.'
          : 'Enter the start and end character offsets of the span (the deep-link start and end values).'}
      </p>
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <fieldset>
        <legend>Cited span</legend>
        <div className="inline-fields">
          <div>
            <label htmlFor="cand-start">Start offset</label>
            <input
              id="cand-start"
              name="startChar"
              inputMode="numeric"
              pattern="[0-9]*"
              required
              value={span.start}
              onChange={e => setSpan(s => ({ ...s, start: e.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="cand-end">End offset</label>
            <input
              id="cand-end"
              name="endChar"
              inputMode="numeric"
              pattern="[0-9]*"
              required
              value={span.end}
              onChange={e => setSpan(s => ({ ...s, end: e.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="cand-evrole">Evidence role</label>
            <select id="cand-evrole" name="evidenceRole" defaultValue="primary">
              <option value="primary">primary</option>
              <option value="supporting">supporting</option>
            </select>
          </div>
        </div>
        {enhanced ? (
          <div className="excerpt" aria-live="polite" data-testid="selected-excerpt">
            {valid ? (
              <>
                <span className="hint">
                  Lines {lineOfOffset(content, start)}–{lineOfOffset(content, Math.max(start, end - 1))}, {end - start} characters
                </span>
                <blockquote>{excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt}</blockquote>
              </>
            ) : (
              <span className="hint">No span selected yet.</span>
            )}
          </div>
        ) : null}
        {enhanced ? (
          <button type="button" className="secondary" onClick={() => fromSelection()}>
            Use current selection
          </button>
        ) : null}
      </fieldset>
      <RecordFields idPrefix="cand" actors={actors} defaults={{ kind: '' }} title={title} onTitleChange={setTitle} />
      {supersedable.length ? (
        <>
          <label htmlFor="cand-supersedes">Supersedes (optional)</label>
          <select id="cand-supersedes" name="supersedesRecordId" defaultValue="">
            <option value="">Nothing</option>
            {supersedable.map(r => (
              <option key={r.id} value={r.id}>
                {r.kind}: {r.title.length > 90 ? `${r.title.slice(0, 89)}…` : r.title}
              </option>
            ))}
          </select>
          <p className="hint">The old record stays current until this candidate is confirmed.</p>
        </>
      ) : null}
      <div className="row actions">
        <SubmitButton>Create candidate</SubmitButton>
      </div>
    </ActionForm>
  );
}
