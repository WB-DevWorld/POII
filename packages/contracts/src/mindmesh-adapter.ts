// MindMesh execution-adapter contract, version 1 (ADR-0011, docs/mindmesh-adapter-contract.md).
// Interface and schemas only. Nothing in POII calls MindMesh, and nothing here is wired into the AI-execution
// port: a future `apps/api/src/adapters/mindmesh.ai-execution.ts` would implement the POII side against these
// shapes. Neither product is a runtime dependency of the other; MindMesh routing is optional and off by default.
//
// The contract is frozen per version. Its enumerations are deliberately copied, not imported from `api.ts`, so a
// change to POII's own HTTP API can never silently change what MindMesh is asked to implement.
//
// Requests are strict (POII never sends a field the version does not name; MindMesh rejects unknown fields).
// Responses are loose (MindMesh may add fields within a version; POII ignores them).
import { z } from 'zod';

export const MINDMESH_CONTRACT_V1 = 'poii.mindmesh.execution.v1' as const;
export const MindMeshContractVersion = z.literal(MINDMESH_CONTRACT_V1);

/** The only operation in v1, and the identifier of the fixed answer schema MindMesh must request upstream. */
export const MINDMESH_OPERATION_V1 = 'extract_candidates' as const;
export const MINDMESH_OUTPUT_SCHEMA_V1 = 'poii.candidates.v1' as const;

/** Paths relative to the configured base URL (the future `POII_AI_PROVIDER_MINDMESH_URL`). */
export const MINDMESH_V1_ENDPOINTS = {
  status: { method: 'GET', path: 'v1/status' },
  quote: { method: 'POST', path: 'v1/quotes' },
  execute: { method: 'POST', path: 'v1/executions' },
  usage: { method: 'GET', path: 'v1/usage' },
} as const;

/** Headers POII sends on every request. `Idempotency-Key` is sent on executions only and equals `executionId`. */
export const MINDMESH_V1_HEADERS = {
  authorization: 'Authorization',
  contractVersion: 'POII-Contract-Version',
  idempotencyKey: 'Idempotency-Key',
} as const;

/** Client-side timeouts POII applies. Executions use `deadlineMs` from the request plus this grace. */
export const MINDMESH_V1_TIMEOUTS = {
  statusMs: 10_000,
  quoteMs: 10_000,
  usageMs: 10_000,
  executeGraceMs: 5_000,
} as const;

// ----- shared pieces -------------------------------------------------------------------------------------

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha256');
const IsoTime = z.iso.datetime({ offset: true });
/** Opaque identifiers chosen by MindMesh (quote ids, route ids). */
const OpaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const Usd = z.number().nonnegative().finite();
const TokenCount = z.number().int().nonnegative();

export const mindMeshCandidateKinds = ['fact', 'requirement', 'decision', 'question'] as const;
export const mindMeshOutcomes = ['ok', 'malformed', 'refused', 'truncated', 'provider_error', 'network_error'] as const;
export const MindMeshCandidateKind = z.enum(mindMeshCandidateKinds);
export const MindMeshOutcome = z.enum(mindMeshOutcomes);

/** USD per million tokens. Mirrors POII's ModelPrice: above `overInputTokens` the whole request uses the higher rates. */
export const MindMeshPricing = z.looseObject({
  inputUsdPerMTok: Usd,
  outputUsdPerMTok: Usd,
  longContext: z.looseObject({
    overInputTokens: z.number().int().positive(),
    inputUsdPerMTok: Usd,
    outputUsdPerMTok: Usd,
  }).optional(),
});

/** Where MindMesh sends the text: one fixed upstream provider and model. Shown to the owner in the preview. */
export const MindMeshRoute = z.looseObject({
  routeId: OpaqueId,
  upstreamProvider: z.string().min(1).max(64),
  upstreamModel: z.string().min(1).max(128),
});

// ----- GET v1/status → AiExecutionPort.status() ----------------------------------------------------------

export const MindMeshStatusResponse = z.looseObject({
  contractVersion: MindMeshContractVersion,
  supportedContractVersions: z.array(z.string()).min(1),
  service: z.looseObject({ name: z.string().min(1), version: z.string().min(1) }),
  /** False while MindMesh cannot take executions; `reason` says why (never a secret). */
  ready: z.boolean(),
  reason: z.string().max(500).nullable(),
  defaultRouteId: OpaqueId.nullable(),
  routes: z.array(MindMeshRoute.extend({
    pricing: MindMeshPricing,
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
  })),
  /** Declarations POII checks before it registers the adapter: every flag must be false. */
  dataHandling: z.looseObject({
    storesPromptText: z.boolean(),
    writesToMemories: z.boolean(),
    trainsOnPromptText: z.boolean(),
    /** How long a finished execution response is kept to answer a retry with the same Idempotency-Key. */
    replayWindowSeconds: z.number().int().min(0).max(86_400),
  }),
  maxDeadlineMs: z.number().int().positive(),
});

// ----- POST v1/quotes → AiExecutionPort.preview() --------------------------------------------------------
// Sent only after POII's disclosure check passed. Carries no source text, no record text and no POII ids:
// sizes and the sha256 of the exact prompt the preview shows.

export const MindMeshQuoteRequest = z.strictObject({
  contractVersion: MindMeshContractVersion,
  operation: z.literal(MINDMESH_OPERATION_V1),
  outputSchema: z.literal(MINDMESH_OUTPUT_SCHEMA_V1),
  promptSha256: Sha256Hex,
  /** UTF-16 code units, as POII counts characters. */
  promptChars: z.number().int().positive(),
  promptUtf8Bytes: z.number().int().positive(),
  inputTokensEstimate: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().max(128_000),
  /** The owner's preferred route (future `POII_AI_MINDMESH_ROUTE`); null lets MindMesh use its default. */
  routeId: OpaqueId.nullable(),
});

export const MindMeshQuoteResponse = z.looseObject({
  contractVersion: MindMeshContractVersion,
  quoteId: OpaqueId,
  /** Echo of the request; an execution must carry text with this hash. */
  promptSha256: Sha256Hex,
  route: MindMeshRoute,
  /** Binding for executions under this quote: cost is computed at these rates from reported usage. */
  pricing: MindMeshPricing,
  /** MindMesh's upper estimate for inputTokensEstimate plus maxOutputTokens at `pricing`. */
  estimatedCostUsd: Usd,
  expiresAt: IsoTime,
});

// ----- POST v1/executions → AiExecutionPort.execute() ----------------------------------------------------

export const MindMeshExecutionRequest = z.strictObject({
  contractVersion: MindMeshContractVersion,
  /** POII's preview id (UUIDv7). Equals the Idempotency-Key header. Each preview executes at most once. */
  executionId: z.uuid(),
  quoteId: OpaqueId,
  /** Must equal the quote's route. MindMesh never substitutes another route or model. */
  routeId: OpaqueId,
  operation: z.literal(MINDMESH_OPERATION_V1),
  outputSchema: z.literal(MINDMESH_OUTPUT_SCHEMA_V1),
  /** Exactly the preview's text, sent upstream as the single user message with nothing added. */
  promptText: z.string().min(1).max(4_000_000),
  promptSha256: Sha256Hex,
  maxOutputTokens: z.number().int().positive().max(128_000),
  /** MindMesh answers (with a definite outcome) within this many milliseconds of receiving the request. */
  deadlineMs: z.number().int().min(1_000).max(900_000),
});

/** A candidate as the model proposed it. Offsets are relative to the document block of the sent text; POII re-anchors. */
export const MindMeshCandidate = z.looseObject({
  kind: MindMeshCandidateKind,
  title: z.string().max(2_000),
  body: z.string().max(40_000),
  quote: z.string(),
  startChar: z.number().int(),
  endChar: z.number().int(),
});

export const MindMeshUsage = z.looseObject({ inputTokens: TokenCount, outputTokens: TokenCount });

export const MindMeshExecutionResponse = z.looseObject({
  contractVersion: MindMeshContractVersion,
  executionId: z.uuid(),
  quoteId: OpaqueId,
  /** The route actually used. POII treats any difference from the quoted route as a contract violation. */
  route: MindMeshRoute,
  /** sha256 of the user message MindMesh sent upstream; null when nothing was sent. Must equal promptSha256. */
  sentPromptSha256: Sha256Hex.nullable(),
  outcome: MindMeshOutcome,
  candidates: z.array(MindMeshCandidate).max(50),
  /** Readable problems. Never contains prompt or answer text. */
  errors: z.array(z.string().max(2_000)).max(50),
  /** Usage as the upstream provider reported it; null when it reported none. */
  usage: MindMeshUsage.nullable(),
  /** False only when nothing was generated or charged for this execution. */
  billed: z.boolean(),
  /** Cost of this execution at the quoted pricing. POII settles its cap with max(this, its own computation). */
  costUsd: Usd,
}).superRefine((r, ctx) => {
  if (!r.billed && (r.costUsd !== 0 || (r.usage !== null && (r.usage.inputTokens !== 0 || r.usage.outputTokens !== 0)))) {
    ctx.addIssue({ code: 'custom', message: 'an unbilled execution reports zero cost and no usage', path: ['billed'] });
  }
  if ((r.outcome === 'ok' || r.outcome === 'truncated' || r.outcome === 'malformed' || r.outcome === 'refused') && r.sentPromptSha256 === null) {
    ctx.addIssue({ code: 'custom', message: 'a model answer implies the text was sent: sentPromptSha256 is required', path: ['sentPromptSha256'] });
  }
  if (r.candidates.length > 0 && r.outcome !== 'ok' && r.outcome !== 'truncated') {
    ctx.addIssue({ code: 'custom', message: 'candidates are returned only with outcome ok or truncated', path: ['candidates'] });
  }
});

// ----- GET v1/usage?month=YYYY-MM → AiExecutionPort.usage() (informational) ------------------------------
// POII's caps are enforced from POII's own ledger; this answer is shown next to it for reconciliation only.

export const MindMeshUsageResponse = z.looseObject({
  contractVersion: MindMeshContractVersion,
  /** Calendar month in UTC, YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  executions: TokenCount,
  billedExecutions: TokenCount,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  costUsd: Usd,
});

// ----- error envelope (any non-2xx answer) ---------------------------------------------------------------
// A non-2xx answer carrying this envelope guarantees nothing was generated or charged (`billed: false`).
// Anything that was charged is answered 200 with an outcome and usage instead.

export const mindMeshErrorCodes = [
  'unauthorized', // 401: missing or wrong bearer secret
  'validation_failed', // 400: body does not match the schema (unknown fields included)
  'unsupported_contract_version', // 400: POII-Contract-Version or contractVersion not supported
  'quote_not_found', // 404
  'quote_expired', // 409
  'quote_mismatch', // 409: promptSha256, routeId or sizes differ from the quote, or sha256(promptText) != promptSha256
  'idempotency_mismatch', // 409: same Idempotency-Key, different body
  'in_progress', // 409: same Idempotency-Key, first request still running
  'route_unavailable', // 503: the quoted route cannot be used now; no other route is tried
  'rate_limited', // 429
  'budget_exhausted', // 429: a MindMesh-side limit; POII's own caps are separate
  'deadline_unachievable', // 400: deadlineMs exceeds maxDeadlineMs
  'internal', // 500
] as const;
export const MindMeshErrorCode = z.enum(mindMeshErrorCodes);

export const MindMeshErrorResponse = z.looseObject({
  contractVersion: MindMeshContractVersion,
  error: z.looseObject({
    code: MindMeshErrorCode,
    /** Readable, at most 1000 characters, never prompt or answer text, never a secret. */
    message: z.string().max(1_000),
    retryable: z.boolean(),
    billed: z.literal(false),
  }),
  requestId: z.string().min(1).max(128),
});

// ----- types -----------------------------------------------------------------------------------------------

export type MindMeshContractVersion = z.infer<typeof MindMeshContractVersion>;
export type MindMeshCandidateKind = z.infer<typeof MindMeshCandidateKind>;
export type MindMeshOutcome = z.infer<typeof MindMeshOutcome>;
export type MindMeshPricing = z.infer<typeof MindMeshPricing>;
export type MindMeshRoute = z.infer<typeof MindMeshRoute>;
export type MindMeshStatusResponse = z.infer<typeof MindMeshStatusResponse>;
export type MindMeshQuoteRequest = z.infer<typeof MindMeshQuoteRequest>;
export type MindMeshQuoteResponse = z.infer<typeof MindMeshQuoteResponse>;
export type MindMeshExecutionRequest = z.infer<typeof MindMeshExecutionRequest>;
export type MindMeshCandidate = z.infer<typeof MindMeshCandidate>;
export type MindMeshUsage = z.infer<typeof MindMeshUsage>;
export type MindMeshExecutionResponse = z.infer<typeof MindMeshExecutionResponse>;
export type MindMeshUsageResponse = z.infer<typeof MindMeshUsageResponse>;
export type MindMeshErrorCode = z.infer<typeof MindMeshErrorCode>;
export type MindMeshErrorResponse = z.infer<typeof MindMeshErrorResponse>;

/**
 * The contract as POII's future adapter would call it: one method per endpoint. A transport that implements
 * this interface talks to one MindMesh install with one per-install bearer secret.
 */
export interface MindMeshExecutionContractV1 {
  readonly contractVersion: typeof MINDMESH_CONTRACT_V1;
  status(): Promise<MindMeshStatusResponse>;
  quote(request: MindMeshQuoteRequest): Promise<MindMeshQuoteResponse>;
  /** `request.executionId` is also sent as the Idempotency-Key header. */
  execute(request: MindMeshExecutionRequest): Promise<MindMeshExecutionResponse>;
  usage(month: string): Promise<MindMeshUsageResponse>;
}

/** Every v1 schema by name. The contract document tags its examples with these names; a test parses them. */
export const mindMeshContractV1Schemas = {
  StatusResponse: MindMeshStatusResponse,
  QuoteRequest: MindMeshQuoteRequest,
  QuoteResponse: MindMeshQuoteResponse,
  ExecutionRequest: MindMeshExecutionRequest,
  ExecutionResponse: MindMeshExecutionResponse,
  UsageResponse: MindMeshUsageResponse,
  ErrorResponse: MindMeshErrorResponse,
} as const;
export type MindMeshContractV1SchemaName = keyof typeof mindMeshContractV1Schemas;
