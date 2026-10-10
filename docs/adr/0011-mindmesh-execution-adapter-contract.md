# ADR-0011 MindMesh execution-adapter contract

Status: proposed · 2026-10-10 · Issue #23 (M3, BUILD-BASELINE §4.3). Interface and documentation only: no MindMesh code, no adapter, no runtime dependency in either direction, no behaviour change in POII. Extends ADR-0007; respects ADR-0001.

Contract for MindMesh's side: [docs/mindmesh-adapter-contract.md](../mindmesh-adapter-contract.md). Schemas: `packages/contracts/src/mindmesh-adapter.ts` (`poii.mindmesh.execution.v1`).

## Context

MindMesh is the owner's other product and owns model routing (OWNERSHIP.md). ADR-0007 says connected deployments can route POII's AI-execution port through MindMesh when it exists, and BUILD-BASELINE §6 lists "MindMesh routing" as a later adapter of that port. Routing through MindMesh is wanted so that one place chooses upstream models and holds provider accounts for the owner's products, and so that POII can use routes it has no direct key for, without POII learning anything about MindMesh's internals.

What must stay true when it is added:

- **The preview shows exactly the text sent.** The owner sees, before anything leaves POII, the exact prompt, where it goes (MindMesh and the upstream provider and model behind the route) and the estimated cost. Execution sends those bytes and nothing else, and MindMesh adds no text of its own (no memories, no system prompt, no retrieval, no tools).
- **Never-send is refused before any client exists.** POII's disclosure check (`apps/api/src/ai/disclosure.ts`) runs before any MindMesh HTTP client is constructed, at preview and again at execute. A never-send source, or a record derived from one, never produces a request to MindMesh, not even a hash.
- **Caps are enforced in POII.** The upper estimate is reserved in POII's own `ai_usage` ledger before the call and settled from reported usage after it. MindMesh's own limits are on top, never instead.
- **No runtime dependency.** POII runs fully without MindMesh, and MindMesh without POII. A MindMesh outage stops only AI actions routed through it; the manual journey and the direct Anthropic and OpenAI adapters are unaffected.
- **Optional and off by default.** With no MindMesh setting, POII behaves exactly as today.
- **Nothing an AI returns is confirmed.** MindMesh's answer becomes candidates with `statement_mode = ai_extracted`, exactly like the direct adapters, and is data, never instructions.
- **Shared records move only by explicit copy or promotion** (ADR-0001). An execution is neither: MindMesh must not keep the prompt or the answer in its ordinary memories.

## Decision

POII and MindMesh agree on a versioned HTTP contract, `poii.mindmesh.execution.v1`, with four endpoints relative to one base URL. POII is always the client; MindMesh never calls POII.

| `AiExecutionPort` method | MindMesh exchange | What crosses |
| --- | --- | --- |
| `status()` | `GET v1/status` | MindMesh → POII: readiness, routes (upstream provider and model, pricing, limits), data-handling declarations, supported contract versions. POII registers the adapter only when every data-handling flag is false and the route has pricing. `status()` is synchronous in the port, so the adapter answers from the last status it fetched (at start and on each preview) and says "not yet fetched" otherwise. |
| `preview()` | `POST v1/quotes` | POII → MindMesh, after disclosure passed: the prompt's sha256, its size in characters and UTF-8 bytes, POII's input-token estimate, the output-token limit, the preferred route. **No text, no POII ids.** MindMesh → POII: a quote id, the route it will use, binding pricing, its upper cost estimate, an expiry. The preview shows MindMesh plus the upstream provider and model, and reserves (later, at execute) the higher of POII's estimate at the quoted pricing and MindMesh's. The preview's expiry is the earlier of POII's preview TTL and the quote's. |
| `getPreview()` | none | Local checks only, plus the quote's expiry. |
| `execute()` | `POST v1/executions` | POII → MindMesh, after disclosure, the sha256 rebuild check and the cap reservation: the exact previewed text, its sha256, the quote id, the route id, the output-token limit, a deadline, and `Idempotency-Key` = POII's preview id. MindMesh → POII: the outcome (POII's six outcomes), the candidates as the model returned them, readable errors, reported usage, whether anything was billed, the cost at the quoted pricing, the route actually used and the sha256 of the text actually sent upstream. |
| `usage()` | `GET v1/usage?month=YYYY-MM` | MindMesh's own count for this install, shown next to POII's ledger for reconciliation. POII's caps never depend on it. |

Rules of the contract (the full text, with examples, is in the contract document):

- **Binding by hash.** The execution's `promptSha256` must equal the quote's, and `sha256(promptText)` must equal it; otherwise MindMesh answers `409 quote_mismatch` without sending anything upstream. MindMesh echoes `sentPromptSha256`, the hash of the user message it actually sent; POII treats a difference, or a route different from the quoted one, as a contract violation: no candidates are created, the reservation stays spent, and the audit log records it.
- **One route, no substitution.** MindMesh sends the text to exactly the quoted route's upstream model. No fallback model, no retry on another provider; if the route is unavailable it answers `503 route_unavailable`.
- **Usage and cost for cap settlement.** MindMesh returns the upstream provider's reported `inputTokens` and `outputTokens` (cache tokens counted as input) and `costUsd` computed at the quote's pricing (same rule as `costMicroUsd` in `apps/api/src/ai/pricing.ts`, rounded up to the micro-dollar). POII settles with the higher of that and its own computation from the same tokens and pricing. `billed: false` means nothing was generated or charged: POII releases the reservation. Usage `null` with `billed: true` keeps the reservation spent, as with the direct adapters when usage is unknown.
- **Error envelope.** Every non-2xx answer is `{ contractVersion, error: { code, message, retryable, billed: false }, requestId }` and guarantees nothing was charged. Anything charged is answered `200` with an outcome. An answer without the envelope (a proxy page, a dropped connection) is treated as unknown and the reservation stays spent.
- **Idempotency.** `Idempotency-Key` equals `executionId` (POII's preview id, used once). The same key and body within MindMesh's declared replay window returns the first response with no second generation or charge; a different body is `409 idempotency_mismatch`; a still-running first request is `409 in_progress`. POII retries an execution at most once, only after a transport failure, with the identical body, before the deadline.
- **Timeouts.** Status, quote and usage: 10 seconds. Execution: POII sends `deadlineMs` (its `POII_AI_TIMEOUT_MS` minus a 5-second grace) and aborts at `POII_AI_TIMEOUT_MS`. MindMesh must answer with a definite outcome within `deadlineMs`, cancelling its upstream call if needed; a deadline above its declared `maxDeadlineMs` is `400 deadline_unachievable`.
- **Versioning.** The version travels in the `POII-Contract-Version` header, in every body and in the path (`v1/`). Within v1 POII sends only the fields the version names (requests are strict) and MindMesh may add response fields (responses are loose). Anything else, including a new operation or a changed meaning, is a new version; MindMesh lists the versions it supports in `status` and answers `400 unsupported_contract_version` otherwise. The enumerations are copied into the contract file, not imported from POII's HTTP API, so changing POII's API never changes the contract silently.
- **Authentication.** `Authorization: Bearer <secret>`: one secret per POII install, generated and set by the owner on both sides (at least 32 random bytes), compared in constant time, never logged, rotatable (MindMesh accepts an old and a new secret during rotation). HTTPS is required except for a loopback address. POII never forwards a person's session, owner token or AccessLobby token to MindMesh.
- **Data handling.** MindMesh does not store the prompt or the answer except to replay a response within its replay window (at most 24 hours), does not write them into its memories, does not train on them, and never puts prompt or answer text into error messages or logs. It declares this in `status.dataHandling`; POII refuses to register the adapter if any flag is true.

### How a future adapter would be selected (named, not implemented)

A later, gated PR would add `apps/api/src/adapters/mindmesh.ai-execution.ts` and a provider name `mindmesh` to the port and to `AiProvider` in the HTTP contract. It would be registered only when all of these hold:

- `POII_AI_ENABLED=true`;
- `POII_AI_PROVIDER_MINDMESH_URL` is set (the base URL; HTTPS unless loopback);
- `POII_AI_PROVIDER_MINDMESH_SECRET` is set;
- `POII_AI_MONTHLY_CAP_USD_MINDMESH` is greater than zero;
- `GET v1/status` reports `ready`, supports `poii.mindmesh.execution.v1`, all data-handling flags false, and pricing for the chosen route.

`POII_AI_MINDMESH_ROUTE` optionally names the preferred route; `POII_AI_PROVIDER_DEFAULT=mindmesh` makes it the default provider. Without these settings nothing changes.

## Out of scope

- Any MindMesh code, any adapter code, and any change to `apps/api` or `apps/web`. The schemas exist in `packages/contracts` but nothing imports them at runtime.
- MindMesh calling POII, MindMesh reading POII's records or context packs, and sharing or promoting records between the products (ADR-0001's copy-or-promotion rules apply, under a separate contract).
- Operations other than candidate extraction, streaming, batch execution, prompt caching, tool use and multi-turn conversations.
- How MindMesh chooses routes, prices them or holds provider keys.
- Machine identities through AccessLobby instead of the bearer secret (a later version may add them).

## Consequences

- MindMesh can implement and test against the contract document and its examples now; POII can add the adapter later without reopening the design.
- The future adapter needs a quote step inside `preview`, which is a second place where a client is constructed. It must sit after `discloseForAi`, exactly like `execute`; the internal `AiProviderClient`/`ProviderRegistration` shapes gain a per-preview quote (route, pricing, expiry), and the `ai_preview` table stores the quote id and route. That PR touches provider, cap and disclosure code and is gated (spending-and-caps, information-policy, ownership-and-data-model).
- Previews through MindMesh fail when MindMesh is down (`409 provider_unavailable`), which is honest: no estimate can be shown without binding pricing. The manual path and the direct adapters keep working.
- `usage()` gains a MindMesh row from POII's ledger; MindMesh's own figure is shown beside it and differences are reported, never used to lower a cap.
- Adding `packages/contracts/src/mindmesh-adapter.ts` is a gated path (ownership-and-data-model) even though it changes no behaviour.
- Open for the owner: whether MindMesh spending has its own USD cap (proposed: a separate `mindmesh` cap, default 0 so it stays off until set) or counts against the upstream provider's USD 20 cap; and whether bearer secrets are acceptable until AccessLobby machine identities exist.
