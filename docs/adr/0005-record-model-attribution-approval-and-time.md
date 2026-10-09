# ADR-0005 Record model: attribution, approval, status, supersession and time

Status: accepted · 2026-10-09 · Data-model changes are a gated class.

## Decision

- **Sources are immutable.** A `source` has one or more `source_revision` rows; content never changes in place. Re-import with identical content is a no-op; different content adds a revision. Hard delete removes content and leaves a `source_tombstone` (id, content hash, deleted time).
- **Locators** anchor a span to a revision: character offsets, line numbers, the excerpt and its hash. When a later revision exists, the excerpt is re-anchored by search; the result is labelled `exact`, `moved` or `lost`. A derived item is never silently re-pointed.
- **Attribution** lives on the record: `stated_by_actor_id`, `stated_role` (owner, assistant, third_party, unknown) and `statement_mode` (quoted, pasted, paraphrased, ai_extracted). Pasted assistant text gets role `assistant` and mode `pasted`; it is never attributed to the owner.
- **Approval** is a separate `approval` row created only by a person actor with authority: approver, authority (owner, delegated), time, `antecedent_record_id` (the exact record being replaced, if any) and a note. A record is `confirmed` only through an approval. Tokens and AI actors cannot create approvals.
- **Review state** (`candidate`, `confirmed`, `rejected`) is separate from **lifecycle status** (`proposed`, `decided`, `implemented`, `observed`, `unknown`). A confirmed record can be `proposed` (confirmed as a proposal) or `observed` (confirmed as a fact seen in reality). Intent and observation are two records that cite different evidence and can disagree.
- **Supersession**: a successor record carries `supersedes_record_id`. The current-decisions view is derived: confirmed decisions with no confirmed successor, walking the chain. Nothing stores "is current".
- **Three times** on every record: `recorded_at` (always known, set by POII), `effective_at` and `observed_at`, each paired with a status of `known`, `unknown`, `not_applicable` or `conflicting`. A conflicting time keeps the competing values in `time_conflicts`.
- **History**: every change appends a `record_version` snapshot and an `audit_event`. Nothing is edited without a version.
- **Permissions pass down**: a record derived from any source with `ai_allowed = false` is not AI-allowed. Deleting a source removes its search entries and marks dependent evidence unavailable in future exports.
- **Idempotency**: imports dedupe on (workspace, content hash, origin key). Mutating API calls accept an `Idempotency-Key`; a retry returns the first result.

## Consequences

Model confidence never grants authority. The UI shows attribution and approval side by side, never merged into one "author" field.
