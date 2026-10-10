// Fixed success notices shown after a redirect (`?notice=<key>`). The URL only ever carries the key.
const notices: Record<string, string> = {
  created: 'Saved.',
  deduplicated:
    'This content was already imported, so POII returned the existing source instead of creating a duplicate. Nothing new was stored.',
  revision: 'Revision saved. Evidence locators were re-anchored against it and labelled exact, moved or lost.',
  updated: 'Source updated.',
  deleted: 'Deleted.',
  edited: 'Changes saved as a new version.',
  confirmed: 'Confirmed. An approval was recorded.',
  rejected: 'Rejected.',
  status: 'Lifecycle status updated.',
  superseding:
    'Superseding candidate created. The record it replaces stays current until this candidate is confirmed.',
};

export function noticeText(key: string | string[] | undefined): string | null {
  if (typeof key !== 'string') return null;
  return notices[key] ?? null;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
