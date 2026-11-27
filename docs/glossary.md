# Glossary: the words POII shows and the codes behind them

POII has two kinds of reader: people (the owner and staff) and programs (AI agents, scripts, the MCP server). They read the same records. ADR-0014 keeps them apart in one way only:

- **Codes** are what the API, the MCP server, context packs (JSON) and agents use: `reviewState: "candidate"`, `statedRole: "third_party"`. They are part of the contract in `packages/contracts`, never change for the sake of wording, and changing one is a gated change.
- **Labels** are what the web app shows people: "Awaiting review", "Someone else". Each code has exactly one label, defined only in `apps/web/src/lib/labels.ts`. The web app keeps the code next to the word (in the element's `data-code` and tooltip, and in each record's "Technical details").

This page lists every label with its code. `apps/web/test/labels.test.ts` fails when a label in the code is missing here, when a contract code has no label, or when two codes of a field share a label. To change a word, change `labels.ts` and this page in the same pull request. The in-app version is at `/glossary`.

## Words used everywhere

| Word on screen | What the API and agents call it | Meaning |
| --- | --- | --- |
| Source | source | A chat, document or note added to POII. Its original text is kept unchanged. |
| Revision | revision | A later version of a source. Earlier revisions are kept. |
| Record | record | A fact, requirement, decision or open question, quoting the passages it rests on. |
| Passage, quoted passage | evidence, span, locator | The exact text of a source that a record quotes, located by character offsets. |
| Awaiting review | candidate (`reviewState: "candidate"`) | Saved, not yet confirmed by a person with authority. |
| Confirm, confirmed by | confirm, approval | A person with authority agrees the record is right; name, authority and time are recorded. |
| Who said it | attribution (`statedBy`, `statedRole`, `statementMode`) | Where a statement came from. Never the same as confirming it. |
| Stage | lifecycle status (`lifecycleStatus`) | Where the thing the record describes stands: proposed, decided, implemented, seen in practice. |
| Replace, replaced by, replacement | supersede, superseded by, successor (`supersedesRecordId`) | A new record takes over from an earlier one once confirmed; the earlier one is kept but stops being current. |
| True from | effective time (`effectiveAt`) | When the statement started to hold. |
| Seen in practice | observed (`observedAt`, lifecycle `observed`) | When someone saw it to be true in reality. |
| Saved in POII | recorded time (`recordedAt`) | When the record was saved. |
| Context pack | context pack (`poii.context-pack`) | An export of records with their quoted evidence, for a colleague or an AI agent. |
| Never send to AI | `aiAllowed: false` | The source and every record quoting it are never sent to an AI provider or put in an export for an AI. |

## Codes and their labels

### Kind of record

API field: `kind`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Fact | `fact` | Something that is or was true. |
| Requirement | `requirement` | Something that must be true or must be done. |
| Decision | `decision` | A choice that was made. |
| Open question | `question` | Something not yet answered or decided. |

### Review

API field: `reviewState`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Awaiting review | `candidate` | Saved, but nobody with authority has confirmed it yet. Agents and exports treat it as unconfirmed. |
| Confirmed | `confirmed` | A person with authority confirmed it. The confirmation is recorded with name and time. |
| Rejected | `rejected` | A person with authority rejected it, with a reason. It is kept for history. |

### Stage

API field: `lifecycleStatus`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Proposed | `proposed` | Suggested, not decided. |
| Decided | `decided` | Agreed, not yet carried out. |
| Implemented | `implemented` | Carried out or put in place. |
| Seen in practice | `observed` | Someone saw it to be true in reality, at the observed time. |
| Stage not known | `unknown` | Nobody has said where it stands. Not the same as "no". |

### Who said it: role

API field: `statedRole`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Owner | `owner` | The workspace owner said it. |
| AI assistant | `assistant` | An AI assistant said or wrote it. Never counts as the owner speaking. |
| Someone else | `third_party` | A person other than the owner said it, such as a colleague or supplier. |
| Role not known | `unknown` | It is not recorded in which role it was said. |

### Who said it: how

API field: `statementMode`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Exact quote | `quoted` | The words are quoted exactly from the source. |
| Pasted text | `pasted` | Text pasted in as it was, for example from a chat. |
| In other words | `paraphrased` | A summary or paraphrase of what the source says. |
| Drafted by AI | `ai_extracted` | An AI drafted it from the source. It stays awaiting review until a person confirms it. |

### Times

API field: `effectiveAtStatus, observedAtStatus`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Known | `known` | The time is known and recorded. |
| Not known | `unknown` | Nobody has recorded the time. Not the same as "never". |
| Not applicable | `not_applicable` | A time does not make sense for this record. |
| Sources disagree | `conflicting` | Sources give different times. Each competing value is listed. |

### Evidence

API field: `evidence role`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Main evidence | `primary` | The passage the record mainly rests on. |
| Supporting | `supporting` | A passage that backs the record up. |

### Quoted passage after a source changes

API field: `anchorResult`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Passage unchanged | `exact` | The quoted passage is still in the source exactly as cited. |
| Passage moved | `moved` | The source changed; the passage was found at a new place. |
| Passage not found | `lost` | The source changed and the passage is no longer in it. Check the record. |

### History

API field: `changeKind`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Created | `create` | The record was saved for the first time. |
| Edited | `edit` | Wording, attribution or times changed. |
| Confirmed | `confirm` | A person with authority confirmed it. |
| Rejected | `reject` | A person with authority rejected it. |
| Replacement linked | `supersede` | It was linked as the replacement of an earlier record. |
| Stage changed | `status` | Its stage or observed time changed. |
| Evidence changed | `evidence` | A quoted passage was added or removed. |

### Current decisions: last seen

API field: `staleness.label`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Recently seen | `observed` | Someone saw it in practice recently. |
| Not seen lately | `stale` | Last seen in practice a while ago. Worth checking it still holds. |
| Never checked | `unknown` | Nobody has recorded seeing it in practice. |

### People and programs

API field: `actor kind`

| Shown as | Code | Meaning |
| --- | --- | --- |
| Person | `person` | A human. |
| AI assistant | `ai_assistant` | An AI assistant such as ChatGPT or Claude. |
| Agent with a token | `agent_token` | A program or AI agent using an access token. |
| POII itself | `system` | A change POII made on its own, such as re-anchoring a passage. |

### Authority to confirm

API field: `authority`

| Shown as | Code | Meaning |
| --- | --- | --- |
| owner | `owner` | The workspace owner, who can confirm anything. |
| delegated | `delegated` | Someone the owner gave authority to confirm. |
