# POII HTTP API — release one

Base path `/v1`. JSON in and out. Schemas live in `packages/contracts/src/api.ts`; the API validates every request with them and the web app types every response with them. Errors are `{ error, message, requestId, details? }` with `x-request-id` echoed. Every response is `cache-control: no-store`.

Authorization goes through the identity port on every request. Release one ships the `local-owner` adapter: the single owner actor with `authority = owner`. The capability rules below are enforced for every actor kind so that M2 tokens (read + propose) need no new code paths.

| Capability | person with authority | agent token | AI actor |
| --- | --- | --- | --- |
| read | yes | yes | no (AI never calls the API) |
| propose (create sources, candidates, evidence, edits of candidates) | yes | yes | no |
| confirm, reject, supersede-and-confirm, set status of confirmed records | yes | **no** | no |
| delete, change `aiAllowed`, restore | yes | **no** | no |

Mutating requests may send `Idempotency-Key: <opaque>`; a retry with the same key and body returns the first response. Different body with the same key is `409 idempotency_mismatch`.

## Identity

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/v1/me` | → `MeResponse` |
| GET | `/v1/actors` | → `ActorView[]` |
| POST | `/v1/actors` | `CreateActorRequest` → `ActorView` (persons created here have no authority) |

## Sources

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| POST | `/v1/sources` | `CreateSourceRequest` → `SourceView` | 201. If `(workspace, originKey)` or `(workspace, sha256(content))` already exists, returns 200 with the existing source and `deduplicated: true`. The original bytes go to the storage port. |
| GET | `/v1/sources` | `ListSourcesQuery` → `SourceView[]` | |
| GET | `/v1/sources/:id` | → `SourceDetail` | Current revision with content. |
| GET | `/v1/sources/:id/revisions/:revisionId` | → `RevisionView` | |
| POST | `/v1/sources/:id/revisions` | `AddRevisionRequest` → `RevisionMeta` | Identical content is a no-op (200, existing revision). New content re-anchors every evidence locator and records `exact`, `moved` or `lost`. |
| PATCH | `/v1/sources/:id` | `UpdateSourceRequest` → `SourceView` | Changing `aiAllowed` recomputes `aiAllowed` on every derived record. |
| DELETE | `/v1/sources/:id` | `DeleteSourceRequest` → 204 | Hard delete: content and search entries go; a `source_tombstone` stays; evidence rows keep `originalSourceId` and become `available: false`. |
| GET | `/v1/sources/:id/records` | → `RecordSummary[]` | Records citing this source. |

## Records

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| POST | `/v1/records` | `CreateRecordRequest` → `RecordDetail` | 201, `reviewState = candidate`. The API builds locators from the revision text (lines, excerpt, hash). `statementMode = ai_extracted` is refused for human callers. |
| GET | `/v1/records` | `ListRecordsQuery` → `RecordSummary[]` | |
| GET | `/v1/records/:id` | → `RecordDetail` | Evidence, approvals, versions, supersession both ways. |
| PATCH | `/v1/records/:id` | `UpdateRecordRequest` → `RecordDetail` | Appends a version. Editing a confirmed record's title, body, kind or attribution is refused (`409 confirmed_record_immutable`): supersede instead. Status and times may change. |
| POST | `/v1/records/:id/evidence` | `EvidenceInput` → `RecordDetail` | |
| DELETE | `/v1/records/:id/evidence/:evidenceId` | → `RecordDetail` | A record keeps at least one evidence row. |
| POST | `/v1/records/:id/confirm` | `ConfirmRecordRequest` → `RecordDetail` | Requires authority. Creates an `approval`; `antecedentRecordId` defaults to `supersedesRecordId`. Refused for rejected records and for token actors (`403 authority_required`). |
| POST | `/v1/records/:id/reject` | `RejectRecordRequest` → `RecordDetail` | Requires authority. |
| POST | `/v1/records/:id/status` | `SetStatusRequest` → `RecordDetail` | Lifecycle status and observed time. |
| POST | `/v1/records/:id/supersede` | `SupersedeRecordRequest` → `RecordDetail` | Creates a new candidate with `supersedesRecordId = :id`. The old record is unaffected until the successor is confirmed. |
| DELETE | `/v1/records/:id` | → 204 | Requires authority. Refused when a confirmed successor cites it as antecedent. |

## Views

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/v1/decisions/current` | `CurrentDecision[]` | Confirmed decisions with no confirmed successor. Derived on every call; nothing stores "current". `staleness.label` is `observed` when observed within 30 days, `stale` when older, `unknown` when never observed. |
| GET | `/v1/search?q=` | `SearchResponse` | PostgreSQL `websearch_to_tsquery` over source revisions (current only) and records; `ts_headline` snippets; for sources the first matching span's offsets. Deleted sources never appear. |

## Exports and backup

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| POST | `/v1/exports/context-pack` | `ContextPackRequest` → `ContextPackResponse` | Markdown and JSON from one manifest. `destination: ai` excludes never-send-to-AI material; excluded and unavailable sources are listed with reasons. Stored as an `export_run`. |
| GET | `/v1/exports` | → `ExportRunView[]` | |
| GET | `/v1/exports/:id` | → `ContextPackResponse` or the backup JSON | |
| POST | `/v1/backup` | → `poii.backup` v1 JSON | Requires authority. Complete workspace with identical ids; original bytes inlined base64. |
| POST | `/v1/restore` | `RestoreRequest` → `RestoreResponse` | Requires authority. Only into an empty workspace (`409 workspace_not_empty`). Idempotent: restoring the same backup twice is a no-op. |

## Health

`GET /health/live` → `{ status, version }`. `GET /health/ready` → `{ status, version, aiEnabled }`, 503 when the database is unavailable.

## Attribution rules and error codes

- `statedRole: owner` requires `statedByActorId` to be the workspace owner (it defaults to the owner when omitted). `statedRole: assistant` requires an `ai_assistant` actor, and an `ai_assistant` actor can only be cited with role `assistant`. Violations return `400 attribution_mismatch`. `statementMode: ai_extracted` from a human caller returns `400 ai_extracted_not_allowed`.
- `timeConflicts` is one list per record; the web app tags each note with `effective:` or `observed:` to show the conflict next to the right time.
- Codes beyond those in the tables: `validation_failed` (400, zod issues in `details`), `not_found` (404), `authority_required` and `forbidden` (403), `already_confirmed`, `record_rejected`, `cannot_supersede_rejected`, `confirmed_record_immutable`, `record_has_confirmed_successor`, `last_evidence`, `revision_content_exists`, `idempotency_mismatch`, `workspace_not_empty`, `conflict` (all 409), `invalid_backup` (400).
- Changing `aiAllowed`, archiving, deleting, backing up and restoring require the `delete` capability (authority).

<!-- #13 AI -->
## AI-assisted extraction (M2, optional)

ADR-0007. Off unless `POII_AI_ENABLED=true` **and** a provider key is set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) **and** the model is in the price table (`apps/api/src/ai/pricing.ts`). While off, every endpoint below answers `503 ai_disabled` and the manual path is unaffected; `MeResponse.aiEnabled` says whether AI is usable.

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| GET | `/v1/ai/status` | → `AiStatusResponse` | Enabled, default provider, each provider's configured state (or why not), model, cap and list price. Never keys. Capability `read`. |
| GET | `/v1/ai/usage` | → `AiUsageResponse` | Current calendar month (UTC): per provider `capUsd`, `spentUsd` (settled from reported usage), `reservedUsd` (calls in flight), `remainingUsd`, `calls`. Capability `read`. |
| POST | `/v1/ai/preview` | `AiPreviewRequest` → `AiPreviewResponse` | 201. Sends nothing. `promptText` is exactly the text `execute` will send, as the single user message; the request carries only that text plus a fixed output schema (`CANDIDATES_JSON_SCHEMA`), the model id and the output-token limit, and no other text. Default span: the whole current revision; at most `POII_AI_MAX_INPUT_CHARS` characters (`400 span_too_large`). `recordIds` adds existing records as "already recorded" context. A never-send source or a record derived from one is `409 ai_not_allowed` (before anything is built). The preview stores the prompt's sha256, not its text, and expires after `POII_AI_PREVIEW_TTL_SECONDS`. Capability `propose`. |
| GET | `/v1/ai/previews/:id` | → `AiPreviewResponse` | The stored preview with its text rebuilt and verified, for showing it again. Same refusals as execute (`409 preview_used`, `preview_expired`, `preview_stale`, `ai_not_allowed`). Sends nothing. Capability `read`. |
| POST | `/v1/ai/execute` | `AiExecuteRequest` → `AiExecuteResponse` | 200. Single use. Re-runs disclosure, rebuilds the prompt and refuses unless its sha256 equals the preview's (`409 preview_stale`); `409 preview_expired`, `409 preview_used`. Reserves the preview's upper cost estimate against the provider's monthly cap: at or over the cap, or when the estimate would exceed it, `409 cap_reached` and nothing is sent. Then sends a request carrying exactly the previewed text plus the fixed output schema, model id and output-token limit (no other text), reconciles the cost from the provider's reported usage (a non-2xx answer with the provider's error envelope, including 5xx and 529, releases the reservation; a transport failure or timeout keeps it counted), and creates candidate records (`reviewState candidate`, `statementMode ai_extracted`, `statedRole assistant`, stated by the `ai_assistant` actor for provider and model, one evidence span each). Nothing is confirmed. A malformed or refused answer is `outcome` `malformed`/`refused` with zero records and readable `errors`, never a 5xx. Requires a person with authority (capability `ai_execute`, see below). |

- Every candidate's span is checked against the sent text: the model's `quote` must occur there (wrong offsets are repaired from the quote; an invented quote drops the candidate with an error).
- The audit log records `ai.previewed`, `ai.preview_refused`, `ai.execute_refused`, `ai.cap_reached` and `ai.executed` with the prompt sha256 and the ids, never prompt or answer text. With `POII_AI_LOG_REQUEST_TEXT=true` the `ai.previewed` event also stores the prompt text (only ever AI-allowed material reaches a prompt).
- Caps: `POII_AI_MONTHLY_CAP_USD_ANTHROPIC`, `POII_AI_MONTHLY_CAP_USD_OPENAI` (default 20 each), per provider per calendar month in UTC, across the instance. A reservation that is never settled (process killed mid-call) keeps counting.
- Capability: executing spends provider budget. Until `authorization.ts` has an `ai_execute` capability, the AI module allows it only for a person with authority (`403 authority_required` otherwise); agent tokens may preview but not execute.
- `POST /v1/ai/preview` is never stored as an Idempotency-Key replay (its reply carries source text); `POST /v1/ai/execute` is.
- Known limits: `ai_usage` and `ai_preview` are outside backup and restore (a restored install starts the month's ledger from zero); expired and unused previews are not pruned yet; a reservation left by a process killed mid-call keeps counting until the month ends.
- Error codes: `ai_disabled` (503), `ai_not_allowed`, `cap_reached`, `preview_expired`, `preview_used`, `preview_stale`, `provider_unavailable` (409), `invalid_span`, `span_too_large`, `too_many_records` (400).
<!-- end #13 AI -->
