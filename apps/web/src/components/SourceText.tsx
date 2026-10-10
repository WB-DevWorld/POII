import { renderLines, type Span } from '@/lib/offsets';

/**
 * The original revision text with line numbers. Every text chunk carries `data-o`, its raw offset in the
 * revision content, so a browser selection can be mapped back to exact UTF-16 offsets. Line numbers come
 * from CSS, so they are never part of the selection.
 */
export function SourceText({ content, revisionId, highlight }: { content: string; revisionId: string; highlight: Span | null }) {
  const lines = renderLines(content, highlight);
  let markedFirst = false;
  return (
    <pre className="source" id="source-text" data-revision={revisionId} data-length={content.length} aria-label="Original source text">
      {lines.map(line => (
        <span className="line" key={line.lineNo} data-line={line.lineNo} data-s={line.start} data-e={line.end}>
          {line.segments.map(segment => {
            if (!segment.highlighted) {
              return (
                <span key={segment.start} data-o={segment.start}>
                  {segment.text}
                </span>
              );
            }
            const first = !markedFirst;
            markedFirst = true;
            return (
              <mark key={segment.start} data-o={segment.start} id={first ? 'span' : undefined} tabIndex={first ? -1 : undefined}>
                {segment.text}
              </mark>
            );
          })}
        </span>
      ))}
    </pre>
  );
}
