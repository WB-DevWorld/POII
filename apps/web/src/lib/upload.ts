// Pure helpers for text uploads.

/** Media type for an uploaded text file; browsers often leave `.md` untyped. */
export function guessMediaType(fileName: string, browserType: string | null | undefined): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (browserType && browserType.length <= 100) return browserType;
  return 'text/plain';
}

/** True when decoded text contains NUL characters, which real text and Markdown files do not. */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000');
}
