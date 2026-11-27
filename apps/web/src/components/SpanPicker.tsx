'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { lineOfOffset, normalizeSpan, pointToOffset, trimSpan, type Span } from '@/lib/offsets';

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

export type EvidenceRoleValue = 'primary' | 'supporting';

export type SpanSelection = {
  /** The offset inputs as typed; empty strings when nothing is picked. */
  span: { start: string; end: string };
  setSpan: (next: { start: string; end: string }) => void;
  role: EvidenceRoleValue;
  setRole: (role: EvidenceRoleValue) => void;
  /** True once the browser runs the script: text selection then drives the offsets. */
  enhanced: boolean;
  /** Reads the browser's current selection into the offsets. False when nothing usable is selected. */
  fromSelection: () => boolean;
  /** The picked span when the two offsets describe one inside the content, otherwise null. */
  picked: Span | null;
  /** Empties the offsets and drops the browser's selection. */
  clear: () => void;
};

/**
 * Follows the text selection inside the source `<pre>` and keeps the matching raw offsets. Without JavaScript
 * the offsets can be typed by hand and the form still submits.
 */
export function useSpanSelection({
  content,
  initialSpan,
  onPick,
  preId = 'source-text',
}: {
  content: string;
  initialSpan: Span | null;
  /** Called with every span taken from a selection (not for typed offsets). */
  onPick?: (span: Span) => void;
  preId?: string;
}): SpanSelection {
  const [span, setSpan] = useState<{ start: string; end: string }>({
    start: initialSpan ? String(initialSpan.start) : '',
    end: initialSpan ? String(initialSpan.end) : '',
  });
  const [role, setRole] = useState<EvidenceRoleValue>('primary');
  const [enhanced, setEnhanced] = useState(false);
  // The newest callback, so the selection listener does not have to be set up again on every render.
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });

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
    pick.current?.(trimmedSpan);
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

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSpan({ start: '', end: '' });
  }, []);

  const start = Number(span.start);
  const end = Number(span.end);
  const valid = span.start !== '' && span.end !== '' && Number.isInteger(start) && Number.isInteger(end) && end > start && end <= content.length;
  return { span, setSpan, role, setRole, enhanced, fromSelection, picked: valid ? { start, end } : null, clear };
}

/** "Lines 3–4, 120 characters" for a span of the content. */
export function spanSummary(content: string, span: Span): string {
  return `Lines ${lineOfOffset(content, span.start)}–${lineOfOffset(content, Math.max(span.start, span.end - 1))}, ${span.end - span.start} characters`;
}

/** The offset inputs, the evidence role and a preview of the picked text. `children` are extra buttons. */
export function SpanFields({
  idPrefix,
  legend,
  content,
  selection,
  required = true,
  excerptTestId = 'selected-excerpt',
  children,
}: {
  idPrefix: string;
  legend: string;
  content: string;
  selection: SpanSelection;
  required?: boolean;
  excerptTestId?: string;
  children?: ReactNode;
}) {
  const { span, setSpan, role, setRole, enhanced, fromSelection, picked } = selection;
  const excerpt = picked ? content.slice(picked.start, picked.end) : '';
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${idPrefix}-start`}>Start position</label>
          <input
            id={`${idPrefix}-start`}
            name="startChar"
            inputMode="numeric"
            pattern="[0-9]*"
            required={required}
            value={span.start}
            onChange={e => setSpan({ ...span, start: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-end`}>End position</label>
          <input
            id={`${idPrefix}-end`}
            name="endChar"
            inputMode="numeric"
            pattern="[0-9]*"
            required={required}
            value={span.end}
            onChange={e => setSpan({ ...span, end: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-evrole`}>Kind of evidence</label>
          <select
            id={`${idPrefix}-evrole`}
            name="evidenceRole"
            value={role}
            onChange={e => setRole(e.target.value === 'supporting' ? 'supporting' : 'primary')}
          >
            <option value="primary">Main evidence</option>
            <option value="supporting">Supporting</option>
          </select>
        </div>
      </div>
      {enhanced ? (
        <div className="excerpt" aria-live="polite" data-testid={excerptTestId}>
          {picked ? (
            <>
              <span className="hint">{spanSummary(content, picked)}</span>
              <blockquote>{excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt}</blockquote>
            </>
          ) : (
            <span className="hint">No passage selected yet.</span>
          )}
        </div>
      ) : null}
      {enhanced ? (
        <div className="row actions">
          <button type="button" className="secondary" onClick={() => fromSelection()}>
            Use current selection
          </button>
          {children}
        </div>
      ) : null}
    </fieldset>
  );
}
