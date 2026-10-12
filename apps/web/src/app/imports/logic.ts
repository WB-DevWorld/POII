// #20 conversation import: pure helpers of the /imports page (selection, file checks, labels). Unit-tested.
import type { ConversationImportOutcome, ConversationImportState, ConversationSummary } from '@poii/contracts';

/** Largest export file the page sends: below the web app's 64 MB server-action limit and the API's 100 MB JSON limit. */
export const MAX_EXPORT_FILE_BYTES = 50 * 1024 * 1024;
/** Mirrors CONVERSATION_IMPORT_MAX_SELECTED in @poii/contracts (a type-only import keeps this file loadable in unit tests). */
export const MAX_SELECTED = 50;

/** A readable reason the file cannot be used, or null. */
export function checkExportFile(file: { name: string; size: number } | null | undefined): string | null {
  if (!file) return 'Choose the conversations.json file from your ChatGPT or Claude.ai export.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_EXPORT_FILE_BYTES) {
    return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_EXPORT_FILE_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/** JSON.parse with a readable failure; the API decides whether the shape is a supported export. */
export function parseExportText(text: string): { ok: true; data: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: 'The file is not valid JSON. Choose conversations.json from inside the export archive.' };
  }
}

/** Only conversations that an import would act on can be chosen; a deleted one stays deleted. */
export const isSelectable = (conversation: Pick<ConversationSummary, 'importState'>): boolean => conversation.importState !== 'deleted';

/**
 * Checks or unchecks one conversation. The result keeps the file's order, contains only selectable ids from
 * this file, and never grows beyond MAX_SELECTED (adding one more is ignored).
 */
export function toggleSelection(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'importState'>>,
  selected: readonly string[],
  id: string,
  checked: boolean,
  max: number = MAX_SELECTED,
): string[] {
  const wanted = new Set(selected);
  if (checked) {
    const target = conversations.find(c => c.id === id);
    if (!target || !isSelectable(target) || (!wanted.has(id) && wanted.size >= max)) return orderedSelection(conversations, selected);
    wanted.add(id);
  } else {
    wanted.delete(id);
  }
  return orderedSelection(conversations, [...wanted]);
}

/** Selected ids in file order, dropping anything that is not a selectable conversation of this file. */
export function orderedSelection(conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'importState'>>, selected: readonly string[]): string[] {
  const wanted = new Set(selected);
  return conversations.filter(c => wanted.has(c.id) && isSelectable(c)).map(c => c.id);
}

export const STATE_LABEL: Record<ConversationImportState, { label: string; tone: '' | 'ok' | 'warn' | 'danger' }> = {
  new: { label: 'new', tone: '' },
  unchanged: { label: 'already imported', tone: 'ok' },
  changed: { label: 'changed: new revision', tone: 'warn' },
  older: { label: 'older than the imported one', tone: 'warn' },
  deleted: { label: 'deleted in POII', tone: 'danger' },
};

export const OUTCOME_LABEL: Record<ConversationImportOutcome, string> = {
  created: 'created',
  revised: 'new revision',
  unchanged: 'unchanged (no-op)',
  older_revision: 'older than the current revision (no-op)',
  deleted_skipped: 'skipped: deleted in POII',
  duplicate_content: 'identical text already stored',
};

/** "2 Mar 2026 – 4 Mar 2026", one date, or "unknown"; dates in UTC so the page renders the same everywhere. */
export function formatSpan(first: string | null, last: string | null): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (!first || !last) return 'unknown';
  const a = day(first);
  const b = day(last);
  return a === b ? a : `${a} – ${b}`;
}
