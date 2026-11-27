// Fixed success notices shown after a redirect (`?notice=<key>`). The URL only ever carries the key.
const notices: Record<string, string> = {
  created: 'Saved.',
  deduplicated:
    'This content was already imported, so POII returned the existing source instead of creating a duplicate. Nothing new was stored.',
  revision: 'New revision saved. POII looked for every quoted passage in it again and marked each one unchanged, moved or not found.',
  updated: 'Source updated.',
  deleted: 'Deleted.',
  edited: 'Changes saved as a new version.',
  confirmed: 'Confirmed. Your name and the time were recorded with it.',
  rejected: 'Rejected. The reason was recorded and the record is kept for history.',
  status: 'Stage updated.',
  'evidence-added': 'Passage added as evidence. The change is in the record’s history.',
  'evidence-removed': 'Passage removed from the evidence. The change is in the record’s history.',
  superseding:
    'Replacement saved for review. The record it replaces stays current until someone with authority confirms the replacement.',
};

export function noticeText(key: string | string[] | undefined): string | null {
  if (typeof key !== 'string') return null;
  return notices[key] ?? null;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?addTo=<record id>`: the record a passage is being picked for. Anything that is not an id is ignored. */
export function addToParam(value: string | string[] | undefined): string | undefined {
  const id = first(value);
  return id && RECORD_ID.test(id) ? id.toLowerCase() : undefined;
}
