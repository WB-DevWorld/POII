// AI-execution port (ADR-0007). Every AI action is two steps: `preview` returns exactly the text that would
// be sent, the provider, the model and the estimated cost; `execute` sends only that previewed text, bound
// by a preview id that expires. Adapters: `off` (default, manual only) and the gated provider execution
// (apps/api/src/ai/execution.ts) that wraps the Anthropic and OpenAI provider clients.
// The manual journey never depends on this port.
import type { RequestContext } from '../common/request-context.js';

export const aiProviderNames = ['anthropic', 'openai'] as const;
export type AiProviderName = (typeof aiProviderNames)[number];

export const candidateKinds = ['fact', 'requirement', 'decision', 'question'] as const;
export type CandidateKind = (typeof candidateKinds)[number];

/** What the caller asks to preview: one source span, optionally with existing records as context. */
export interface AiPreviewRequest {
  sourceId: string;
  /** Defaults to the source's current revision. */
  revisionId?: string;
  /** Defaults to the whole revision. UTF-16 code units, like every locator. */
  startChar?: number;
  endChar?: number;
  /** Existing records included as "already recorded" context so the model does not repeat them. */
  recordIds?: string[];
  /** Defaults to POII_AI_PROVIDER_DEFAULT, then the first configured provider. */
  provider?: AiProviderName;
}

export interface AiPreview {
  previewId: string;
  provider: AiProviderName;
  model: string;
  /** Exactly what will be sent as the single user message, byte for byte. Nothing else carries source text. */
  promptText: string;
  promptSha256: string;
  sourceId: string;
  revisionId: string;
  startChar: number;
  endChar: number;
  recordIds: string[];
  inputTokensEstimate: number;
  maxOutputTokens: number;
  /** Upper estimate: estimated input plus the maximum output, at the model's list price. This is what is reserved. */
  estimatedCostUsd: number;
  /** What is left of this provider's monthly cap now (cap minus spent minus reserved). */
  remainingCapUsd: number;
  monthlyCapUsd: number;
  expiresAt: Date;
}

/** One candidate the model proposed, located in the source revision (offsets already verified against the text). */
export interface ExtractedCandidate {
  kind: CandidateKind;
  title: string;
  body: string;
  /** Offsets in the source revision (UTF-16 code units). */
  startChar: number;
  endChar: number;
}

export type AiOutcome = 'ok' | 'malformed' | 'refused' | 'truncated' | 'provider_error' | 'network_error';

export interface AiExecution {
  previewId: string;
  provider: AiProviderName;
  model: string;
  sourceId: string;
  revisionId: string;
  promptSha256: string;
  outcome: AiOutcome;
  candidates: ExtractedCandidate[];
  /** Readable problems: malformed output, dropped candidates, provider errors. Never contains prompt text. */
  errors: string[];
  usage: { inputTokens: number | null; outputTokens: number | null; reservedUsd: number; costUsd: number; reconciled: boolean };
}

export interface AiProviderStatus {
  provider: AiProviderName;
  configured: boolean;
  model: string;
  /** Why the provider cannot be used, when it is not configured. */
  reason: string | null;
  monthlyCapUsd: number;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
}

export interface AiStatusInfo {
  enabled: boolean;
  defaultProvider: AiProviderName | null;
  providers: AiProviderStatus[];
  previewTtlSeconds: number;
  maxInputChars: number;
  maxOutputTokens: number;
  logRequestText: boolean;
}

export interface AiUsageRow {
  provider: AiProviderName;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  calls: number;
}

export interface AiUsageInfo {
  /** Calendar month in UTC, YYYY-MM. */
  month: string;
  providers: AiUsageRow[];
}

export interface AiExecutionPort {
  readonly name: string;
  readonly enabled: boolean;
  status(): AiStatusInfo;
  usage(): Promise<AiUsageInfo>;
  preview(ctx: RequestContext, request: AiPreviewRequest): Promise<AiPreview>;
  execute(ctx: RequestContext, previewId: string): Promise<AiExecution>;
}

// ----- provider clients (constructed only after disclosure has passed) -----------------------------

/** fetch, injected so tests can stub it. Never a global monkeypatch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A candidate as returned by a provider, offsets relative to the DOCUMENT block of the sent text. */
export interface RawCandidate {
  kind: CandidateKind;
  title: string;
  body: string;
  startChar: number;
  endChar: number;
  quote: string;
}

export interface ProviderCallResult {
  outcome: AiOutcome;
  candidates: RawCandidate[];
  errors: string[];
  /** Usage as the provider reported it; null when the provider reported none. */
  usage: { inputTokens: number; outputTokens: number } | null;
  httpStatus: number | null;
  /** True when the provider rejected the request with a client error before generating (nothing billed). */
  notBilled: boolean;
}

export interface AiProviderClient {
  readonly provider: AiProviderName;
  readonly model: string;
  /** Sends `promptText` as the only user message and parses the structured candidates. Never throws. */
  extract(promptText: string, options: { maxOutputTokens: number; timeoutMs: number }): Promise<ProviderCallResult>;
}
