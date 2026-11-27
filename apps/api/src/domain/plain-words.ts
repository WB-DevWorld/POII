// Plain words that context packs and agent instruction files add next to POII's codes (ADR-0014).
// The codes are never replaced or removed: agents and programs keep reading them. These words are the same as
// the web app's labels (apps/web/src/lib/labels.ts); test/plain-words.test.ts checks them against docs/glossary.md.
import type { AnchorResult, LifecycleStatus, RecordKind, ReviewState, StatedRole, StatementMode } from '@poii/contracts';

export const recordKindWords: Record<RecordKind, string> = {
  fact: 'Fact',
  requirement: 'Requirement',
  decision: 'Decision',
  question: 'Open question',
};

export const reviewStateWords: Record<ReviewState, string> = {
  candidate: 'Awaiting review',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
};

export const lifecycleStatusWords: Record<LifecycleStatus, string> = {
  proposed: 'Proposed',
  decided: 'Decided',
  implemented: 'Implemented',
  observed: 'Seen in practice',
  unknown: 'Stage not known',
};

export const statedRoleWords: Record<StatedRole, string> = {
  owner: 'Owner',
  assistant: 'AI assistant',
  third_party: 'Someone else',
  unknown: 'Role not known',
};

export const statementModeWords: Record<StatementMode, string> = {
  quoted: 'Exact quote',
  pasted: 'Pasted text',
  paraphrased: 'In other words',
  ai_extracted: 'Drafted by AI',
};

export const anchorResultWords: Record<AnchorResult, string> = {
  exact: 'Passage unchanged',
  moved: 'Passage moved',
  lost: 'Passage not found',
};

export const stalenessWords: Record<'observed' | 'stale' | 'unknown', string> = {
  observed: 'Recently seen',
  stale: 'Not seen lately',
  unknown: 'Never checked',
};

/** Every vocabulary above with its code, for the glossary check. */
export const plainWordTables: Record<string, string>[] = [
  recordKindWords,
  reviewStateWords,
  lifecycleStatusWords,
  statedRoleWords,
  statementModeWords,
  anchorResultWords,
  stalenessWords,
];

const word = (table: Record<string, string>, value: string | null | undefined) =>
  value ? (table[value] ?? value.replace(/_/g, ' ')) : 'not recorded';

/** "Decision, confirmed; stage: Decided; still current." Never replaces the coded line it follows. */
export function plainRecordLine(r: { kind: string; reviewState: string; lifecycleStatus: string; current: boolean }): string {
  const review = r.reviewState === 'candidate' ? 'awaiting review (not confirmed, treat as unconfirmed)' : word(reviewStateWords, r.reviewState).toLowerCase();
  const current = r.current ? 'still current' : 'not current (replaced or rejected)';
  return `${word(recordKindWords, r.kind)}, ${review}; stage: ${word(lifecycleStatusWords, r.lifecycleStatus)}; ${current}.`;
}

export const roleWord = (role: string) => word(statedRoleWords, role);
export const modeWord = (mode: string) => word(statementModeWords, mode);
export const anchorWord = (result: string) => word(anchorResultWords, result);
export const stalenessWord = (label: string) => word(stalenessWords, label);
export const kindWord = (kind: string) => word(recordKindWords, kind);
export const stageWord = (status: string) => word(lifecycleStatusWords, status);

/** Public glossary of the words and codes. The POII repository is public. */
export const GLOSSARY_URL = 'https://github.com/WB-DevWorld/POII/blob/main/docs/glossary.md';
