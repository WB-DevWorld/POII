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
