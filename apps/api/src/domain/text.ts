/** Lines in a text: a trailing newline does not start a new line; the empty text has none. */
export function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}
