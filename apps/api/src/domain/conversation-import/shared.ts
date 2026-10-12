// #20 conversation import: helpers shared by both parsers. Pure.

/** Conversation ids become origin keys and appear in rendered text: a conservative character set. */
export const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export const UNTITLED = 'Untitled conversation';

/** The export file did not have a supported shape. Mapped to 400 unsupported_export by the caller. */
export class ExportShapeError extends Error {
  constructor(message: string, readonly issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = 'ExportShapeError';
  }
}

/** One line, no control characters, at most 300 characters. */
export function cleanTitle(value: string | null | undefined): string {
  const title = (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return UNTITLED;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

/** LF line endings, no NUL (stored text may not contain it), leading blank lines and trailing whitespace removed. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}
