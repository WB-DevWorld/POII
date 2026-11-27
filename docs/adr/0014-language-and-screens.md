# ADR-0014 Language and screens: plain words for people, exact codes for programs

Status: proposed · 2026-11-27 · Applies ND-5 ("You decide UI/UX … and record material choices as short ADRs"). Fills a gap: until now no ADR covered screen wording or design, so the web app showed the data model's own words (`candidate`, `supersede`, `ai_extracted`, "span", "antecedent"). The first staff test (26 Nov 2026) showed the cost. Changing the export or context-pack wording stays a gated class (ADR-0008); changing a code stays a gated contract change.

## Context

POII has two kinds of reader of the same records: people (the owner and non-technical staff, in the web app) and programs (AI agents, scripts and the MCP server, through the API, the MCP tools and context packs). People need plain words. Agents need exact, stable values. Simplifying the data for people would weaken it for agents, and showing people the codes makes the app hard to use.

## Decision

Rules are marked **required** or **recommended** so that an agent implementing them knows which ones are hard rules.

### 1. Two layers (required)

- **Codes** (`reviewState: "candidate"`, `statedRole: "third_party"`, `changeKind: "supersede"`, record ids, timestamps, offsets, hashes) are the contract in `packages/contracts`. They are what the API, MCP, the JSON pack and exports carry. They are never renamed for wording reasons.
- **Labels** are the words the web app shows. Each code has exactly one label and one plain meaning, defined only in `apps/web/src/lib/labels.ts` and listed in `docs/glossary.md` and on the in-app `/glossary` page. A `Vocabulary<Code>` type makes `tsc` fail when a contract code has no label; `apps/web/test/labels.test.ts` fails when the glossary page misses a label or two codes of one field share a label.
- **The code stays reachable.** A label element carries its code in `data-code` and in its tooltip ("… (code: candidate)"), and each record page has "Technical details" listing its id and codes. Browser tests assert the code (`data-code`), so rewording a label never weakens a test.
- **Readers of both layers.** The Markdown context pack and the generated `AGENTS.md`/`CLAUDE.md` are read by people and agents. They keep every code and id and add the plain word next to it; they never replace a code with a word. Changes there go through a gated PR (ADR-0008).

### 2. Words (required)

- Use the glossary words: a candidate is "awaiting review", supersede is "replace", a span is a "passage", attribution is "who said it", lifecycle status is "stage", approval is "confirmed by". Write for a colleague who has never seen POII.
- Name an action by its real effect: "Save for review", not "Create candidate"; "Write a replacement…", not "Supersede…". A button never claims more than happens. Saving a record does not confirm it, and an export does not mean an agent has read it.
- After an action, say what changed and what did not ("The record it replaces stays current until …"). Before a destructive action, say what is lost, what stays, and whether it can be undone.
- Keep "not known" apart from "no" or "never" everywhere: unknown times, an unknown stage and a speaker who was not recorded are shown as such, never as an empty field or a negative.
- Do not show certainty that is not there. Who said something, whether it was confirmed, whether it was replaced, and whether its quoted passage still matches are separate facts, shown separately, never one combined badge.

### 3. Messages (required)

Each failure message says which of three things happened, in its own words:

1. **Something is missing or wrong in what you entered**: say what and how to fix it, next to the field; keep what was typed.
2. **You are not allowed to do this**: say who can.
3. **POII or a service failed**: say that the person's saved work was not changed, or, after a timeout, that they should check before trying again.

Behind each plain message there is a stable error code from the API (`explainCode` in `apps/web/src/lib/format.ts`), which agents use. A plain message never replaces the code in API responses.

### 4. Screens (recommended)

- The home page leads with work: what is awaiting review, the current decisions, what was replaced. Setup pages come after.
- Actions sit on the record they change, after its identity, status and consequences.
- A list, pack or search result states what it covers, in particular whether records awaiting review are included.
- One set of screens for everyone; what someone may do decides which actions show. Read-only content is shown as text, not as disabled forms.
- On a phone, looking things up and reviewing come first; tables scroll or collapse (#99). Configuration can stay desktop-first.

### 5. Accessibility (required)

WCAG 2.2 level AA. Targets at least 24×24 CSS pixels. Labels on every control, never colour alone for a state (every coloured tag has a word), visible focus, no single-key shortcuts that act without a modifier. New pages get an automated accessibility check in the browser tests when that check is added; until then, keyboard and screen-reader basics are checked by hand on changed pages.

## Consequences

- The first pass (web screens outside the gated paths) rewrites the labels and messages, adds the glossary and keeps every code in `data-code`. It changes no API, contract, export or pack output, so agents see exactly what they saw before.
- Still to do under this ADR, each as its own PR: the gated web pages (sign-in, tokens, account, AI extraction) and the Markdown context pack and agent instructions (plain words added next to codes, format version unchanged unless meaning changes). A separate, gated contract change: show a confirmation as out of date when a quoted passage it covered later moved or was lost (today the passage is marked "moved" or "not found", but the confirmation does not say so).
- A label change is a routine web change, provided `labels.ts`, `docs/glossary.md` and the tests change together. A code change is a gated contract change and needs a new label in the same PR.
