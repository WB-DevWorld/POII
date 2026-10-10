// OpenAI provider client for the AI-execution port (ADR-0007). Plain fetch, injected; no SDK.
// Request and response shapes: Responses API, POST https://api.openai.com/v1/responses with
// Authorization: Bearer; JSON answer constrained by text.format (type json_schema, strict). Response:
// { status: "completed" | "incomplete" | "failed", model, output: [{ type: "reasoning" } | { type: "message",
// content: [{ type: "output_text", text } | { type: "refusal", refusal }] }], incomplete_details: { reason },
// usage: { input_tokens, output_tokens } }; errors: { error: { message, type, code } }.
// Confirmed against the OpenAI API reference on 2026-10-10. `store: false` keeps the request out of
// OpenAI's stored responses.
// This client is constructed only after disclosure has passed, and it is the only code that sends text.
import { z } from 'zod';
import { CANDIDATES_JSON_SCHEMA, parseCandidatesText } from '../ai/candidates.js';
import type { AiProviderClient, FetchLike, ProviderCallResult } from '../ports/ai-execution.js';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const ContentPart = z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() }).passthrough();
const OutputItem = z.object({ type: z.string(), content: z.array(ContentPart).optional() }).passthrough();

const ResponseObject = z.object({
  status: z.string().optional(),
  model: z.string().optional(),
  output: z.array(OutputItem),
  incomplete_details: z.object({ reason: z.string().optional() }).passthrough().nullable().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().nullable().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).passthrough().nullable().optional(),
}).passthrough();

const ErrorResponse = z.object({ error: z.object({ type: z.string().nullable().optional(), message: z.string().optional() }).passthrough() }).passthrough();


export class OpenAiAiExecution implements AiProviderClient {
  readonly provider = 'openai' as const;

  constructor(
    private readonly options: { apiKey: string; model: string; fetch: FetchLike; url?: string },
  ) {}

  get model(): string {
    return this.options.model;
  }

  /** The exact JSON body sent. Exposed so tests can prove the input equals the preview. */
  requestBody(promptText: string, maxOutputTokens: number): Record<string, unknown> {
    return {
      model: this.options.model,
      input: promptText,
      max_output_tokens: maxOutputTokens,
      store: false,
      text: { format: { type: 'json_schema', name: 'poii_candidates', schema: CANDIDATES_JSON_SCHEMA, strict: true } },
    };
  }

  async extract(promptText: string, options: { maxOutputTokens: number; timeoutMs: number }): Promise<ProviderCallResult> {
    let response: Response;
    try {
      response = await this.options.fetch(this.options.url ?? OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify(this.requestBody(promptText, options.maxOutputTokens)),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      return failure('network_error', `OpenAI ${reason}; it is unknown whether the request was processed.`, null, false);
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
      return failure('provider_error', `OpenAI answered ${response.status} (${detail}).`, response.status, err.success);
    }
    const parsed = ResponseObject.safeParse(json);
    if (!parsed.success) {
      return failure('malformed', 'OpenAI returned a response that is not a Responses API object; no candidates were created.', response.status, false);
    }
    const body = parsed.data;
    const usage = body.usage ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } : null;
    const parts = body.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
    if (parts.some(part => part.type === 'refusal')) {
      return { outcome: 'refused', candidates: [], errors: ['OpenAI declined the request; no candidates were created.'], usage, httpStatus: response.status, notBilled: false };
    }
    if (body.status === 'failed') {
      return { outcome: 'provider_error', candidates: [], errors: [`OpenAI reported a failed response (${(body.error?.message ?? 'no detail').slice(0, 300)}).`], usage, httpStatus: response.status, notBilled: false };
    }
    const text = parts.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    const result = parseCandidatesText(text);
    if (body.status === 'incomplete') {
      return {
        outcome: result.malformed ? 'truncated' : 'ok',
        candidates: result.candidates,
        errors: [`OpenAI stopped early (${body.incomplete_details?.reason ?? 'incomplete'}); the answer may be incomplete.`, ...result.errors],
        usage, httpStatus: response.status, notBilled: false,
      };
    }
    return { outcome: result.malformed ? 'malformed' : 'ok', candidates: result.candidates, errors: result.errors, usage, httpStatus: response.status, notBilled: false };
  }
}

function failure(outcome: ProviderCallResult['outcome'], message: string, httpStatus: number | null, notBilled: boolean): ProviderCallResult {
  return { outcome, candidates: [], errors: [message], usage: null, httpStatus, notBilled };
}
