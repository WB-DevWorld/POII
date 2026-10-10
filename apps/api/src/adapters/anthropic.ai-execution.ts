// Anthropic provider client for the AI-execution port (ADR-0007). Plain fetch, injected; no SDK.
// Request and response shapes: Messages API, POST https://api.anthropic.com/v1/messages with headers
// x-api-key and anthropic-version: 2023-06-01; JSON answer constrained by output_config.format
// (type json_schema). Response: { model, content: [{ type: "thinking" | "text", ... }], stop_reason,
// usage: { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? } };
// errors: { type: "error", error: { type, message } }. Confirmed against the Claude API docs on 2026-10-10.
//
// Deliberately not used: server-side refusal fallbacks (they would send the previewed text to a model other
// than the one previewed, at that model's price) and prompt caching (one-shot extraction).
// This client is constructed only after disclosure has passed, and it is the only code that sends text.
import { z } from 'zod';
import { CANDIDATES_JSON_SCHEMA, parseCandidatesText } from '../ai/candidates.js';
import type { AiProviderClient, FetchLike, ProviderCallResult } from '../ports/ai-execution.js';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const MessageResponse = z.object({
  model: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const ErrorResponse = z.object({ error: z.object({ type: z.string().optional(), message: z.string().optional() }).passthrough() }).passthrough();


export class AnthropicAiExecution implements AiProviderClient {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly options: { apiKey: string; model: string; fetch: FetchLike; url?: string },
  ) {}

  get model(): string {
    return this.options.model;
  }

  /** The exact JSON body sent. Exposed so tests can prove the user message equals the preview. */
  requestBody(promptText: string, maxOutputTokens: number): Record<string, unknown> {
    return {
      model: this.options.model,
      max_tokens: maxOutputTokens,
      messages: [{ role: 'user', content: promptText }],
      output_config: { format: { type: 'json_schema', schema: CANDIDATES_JSON_SCHEMA } },
    };
  }

  async extract(promptText: string, options: { maxOutputTokens: number; timeoutMs: number }): Promise<ProviderCallResult> {
    let response: Response;
    try {
      response = await this.options.fetch(this.options.url ?? ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(this.requestBody(promptText, options.maxOutputTokens)),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      return failure('network_error', `Anthropic ${reason}; it is unknown whether the request was processed.`, null, false);
    }
    const raw = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const err = ErrorResponse.safeParse(json);
      const detail = err.success ? `${err.data.error.type ?? 'error'}: ${(err.data.error.message ?? '').slice(0, 300)}` : 'no error body';
      // A non-2xx answer carrying the provider's error envelope (4xx, 5xx, 529 overloaded) means the request was
      // rejected without a billed generation: the reservation is released. Without an envelope (a proxy page,
      // say) it is unknown whether the provider processed it, so the reservation stays counted.
      return failure('provider_error', `Anthropic answered ${response.status} (${detail}).`, response.status, err.success);
    }
    const parsed = MessageResponse.safeParse(json);
    if (!parsed.success) {
      return failure('malformed', 'Anthropic returned a response that is not a Messages API message; no candidates were created.', response.status, false);
    }
    const message = parsed.data;
    const usage = message.usage
      ? {
        // Cache tokens are counted as input at the base price (conservative; caching is not used).
        inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      }
      : null;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    if (message.stop_reason === 'refusal') {
      return { outcome: 'refused', candidates: [], errors: ['Anthropic declined the request; no candidates were created.'], usage, httpStatus: response.status, notBilled: false };
    }
    const result = parseCandidatesText(text);
    if (message.stop_reason === 'max_tokens') {
      return {
        outcome: result.malformed ? 'truncated' : 'ok',
        candidates: result.candidates,
        errors: ['Anthropic stopped at the output limit; the answer may be incomplete.', ...result.errors],
        usage, httpStatus: response.status, notBilled: false,
      };
    }
    return {
      outcome: result.malformed ? 'malformed' : 'ok',
      candidates: result.candidates,
      errors: result.errors,
      usage, httpStatus: response.status, notBilled: false,
    };
  }
}

function failure(outcome: ProviderCallResult['outcome'], message: string, httpStatus: number | null, notBilled: boolean): ProviderCallResult {
  return { outcome, candidates: [], errors: [message], usage: null, httpStatus, notBilled };
}
