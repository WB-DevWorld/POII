// The words people see for POII's codes (ADR-0014, docs/glossary.md).
//
// A `Vocabulary<Code>` must name every code of the contract and nothing else, so `tsc` fails when the
// contract gains a code without a label.
//
// Two layers: the codes in `@poii/contracts` are what the API, the MCP server, exports and agents use, and they
// never change here. Each code has exactly one label for people, defined only in this file. A page shows the
// label and keeps the code in `data-code` (and in the tooltip), so a test, a script or a curious reader can
// still see exactly which code a word stands for. Change a label here and in docs/glossary.md together.
import type {
  ActorKind,
  AnchorResult,
  Authority,
  EvidenceRole,
  LifecycleStatus,
  RecordKind,
  ReviewState,
  StatedRole,
  StatementMode,
  TimeStatus,
} from '@poii/contracts';

export type Term = { label: string; meaning: string };

type Vocabulary<C extends string> = Record<C, Term>;

export const recordKindTerms: Vocabulary<RecordKind> = {
  fact: { label: 'Fact', meaning: 'Something that is or was true.' },
  requirement: { label: 'Requirement', meaning: 'Something that must be true or must be done.' },
  decision: { label: 'Decision', meaning: 'A choice that was made.' },
  question: { label: 'Open question', meaning: 'Something not yet answered or decided.' },
};

export const reviewStateTerms: Vocabulary<ReviewState> = {
  candidate: {
    label: 'Awaiting review',
    meaning: 'Saved, but nobody with authority has confirmed it yet. Agents and exports treat it as unconfirmed.',
  },
  confirmed: { label: 'Confirmed', meaning: 'A person with authority confirmed it. The confirmation is recorded with name and time.' },
  rejected: { label: 'Rejected', meaning: 'A person with authority rejected it, with a reason. It is kept for history.' },
};

export const lifecycleStatusTerms: Vocabulary<LifecycleStatus> = {
  proposed: { label: 'Proposed', meaning: 'Suggested, not decided.' },
  decided: { label: 'Decided', meaning: 'Agreed, not yet carried out.' },
  implemented: { label: 'Implemented', meaning: 'Carried out or put in place.' },
  observed: { label: 'Seen in practice', meaning: 'Someone saw it to be true in reality, at the observed time.' },
  unknown: { label: 'Stage not known', meaning: 'Nobody has said where it stands. Not the same as "no".' },
};

export const statedRoleTerms: Vocabulary<StatedRole> = {
  owner: { label: 'Owner', meaning: 'The workspace owner said it.' },
  assistant: { label: 'AI assistant', meaning: 'An AI assistant said or wrote it. Never counts as the owner speaking.' },
  third_party: { label: 'Someone else', meaning: 'A person other than the owner said it, such as a colleague or supplier.' },
  unknown: { label: 'Role not known', meaning: 'It is not recorded in which role it was said.' },
};

export const statementModeTerms: Vocabulary<StatementMode> = {
  quoted: { label: 'Exact quote', meaning: 'The words are quoted exactly from the source.' },
  pasted: { label: 'Pasted text', meaning: 'Text pasted in as it was, for example from a chat.' },
  paraphrased: { label: 'In other words', meaning: 'A summary or paraphrase of what the source says.' },
  ai_extracted: { label: 'Drafted by AI', meaning: 'An AI drafted it from the source. It stays awaiting review until a person confirms it.' },
};

export const timeStatusTerms: Vocabulary<TimeStatus> = {
  known: { label: 'Known', meaning: 'The time is known and recorded.' },
  unknown: { label: 'Not known', meaning: 'Nobody has recorded the time. Not the same as "never".' },
  not_applicable: { label: 'Not applicable', meaning: 'A time does not make sense for this record.' },
  conflicting: { label: 'Sources disagree', meaning: 'Sources give different times. Each competing value is listed.' },
};

export const actorKindTerms: Vocabulary<ActorKind> = {
  person: { label: 'Person', meaning: 'A human.' },
  ai_assistant: { label: 'AI assistant', meaning: 'An AI assistant such as ChatGPT or Claude.' },
  agent_token: { label: 'Agent with a token', meaning: 'A program or AI agent using an access token.' },
  system: { label: 'POII itself', meaning: 'A change POII made on its own, such as re-anchoring a passage.' },
};

export const authorityTerms: Vocabulary<Authority> = {
  owner: { label: 'owner', meaning: 'The workspace owner, who can confirm anything.' },
  delegated: { label: 'delegated', meaning: 'Someone the owner gave authority to confirm.' },
};

export const evidenceRoleTerms: Vocabulary<EvidenceRole> = {
  primary: { label: 'Main evidence', meaning: 'The passage the record mainly rests on.' },
  supporting: { label: 'Supporting', meaning: 'A passage that backs the record up.' },
};

export const anchorResultTerms: Vocabulary<AnchorResult> = {
  exact: { label: 'Passage unchanged', meaning: 'The quoted passage is still in the source exactly as cited.' },
  moved: { label: 'Passage moved', meaning: 'The source changed; the passage was found at a new place.' },
  lost: { label: 'Passage not found', meaning: 'The source changed and the passage is no longer in it. Check the record.' },
};

/** Record history entries (`changeKind`). Not a contract enum export, so listed here with the API's values. */
export const changeKindTerms: Record<string, Term> = {
  create: { label: 'Created', meaning: 'The record was saved for the first time.' },
  edit: { label: 'Edited', meaning: 'Wording, attribution or times changed.' },
  confirm: { label: 'Confirmed', meaning: 'A person with authority confirmed it.' },
  reject: { label: 'Rejected', meaning: 'A person with authority rejected it.' },
  supersede: { label: 'Replacement linked', meaning: 'It was linked as the replacement of an earlier record.' },
  status: { label: 'Stage changed', meaning: 'Its stage or observed time changed.' },
  evidence: { label: 'Evidence changed', meaning: 'A quoted passage was added or removed.' },
};

/** Staleness of a current decision (`/v1/decisions/current`). */
export const stalenessTerms: Record<'observed' | 'stale' | 'unknown', Term> = {
  observed: { label: 'Recently seen', meaning: 'Someone saw it in practice recently.' },
  stale: { label: 'Not seen lately', meaning: 'Last seen in practice a while ago. Worth checking it still holds.' },
  unknown: { label: 'Never checked', meaning: 'Nobody has recorded seeing it in practice.' },
};

/** The label for a code; an unknown code is shown as it is, so nothing is ever hidden. */
export function labelOf(terms: Record<string, Term>, code: string | null | undefined): string {
  if (!code) return '';
  return terms[code]?.label ?? code.replace(/_/g, ' ');
}

/** Tooltip text: what the word means, plus the code the API and agents use. */
export function codeTitle(terms: Record<string, Term>, code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const meaning = terms[code]?.meaning;
  return meaning ? `${meaning} (code: ${code})` : `code: ${code}`;
}

/** Everything the glossary page and docs/glossary.md list, in this order. */
export const glossary: { heading: string; field: string; terms: Record<string, Term> }[] = [
  { heading: 'Kind of record', field: 'kind', terms: recordKindTerms },
  { heading: 'Review', field: 'reviewState', terms: reviewStateTerms },
  { heading: 'Stage', field: 'lifecycleStatus', terms: lifecycleStatusTerms },
  { heading: 'Who said it: role', field: 'statedRole', terms: statedRoleTerms },
  { heading: 'Who said it: how', field: 'statementMode', terms: statementModeTerms },
  { heading: 'Times', field: 'effectiveAtStatus, observedAtStatus', terms: timeStatusTerms },
  { heading: 'Evidence', field: 'evidence role', terms: evidenceRoleTerms },
  { heading: 'Quoted passage after a source changes', field: 'anchorResult', terms: anchorResultTerms },
  { heading: 'History', field: 'changeKind', terms: changeKindTerms },
  { heading: 'Current decisions: last seen', field: 'staleness.label', terms: stalenessTerms },
  { heading: 'People and programs', field: 'actor kind', terms: actorKindTerms },
  { heading: 'Authority to confirm', field: 'authority', terms: authorityTerms },
];
