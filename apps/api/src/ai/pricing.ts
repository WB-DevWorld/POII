// #13 AI price table (ADR-0007): USD per million tokens, standard tier, no batch, no cache discounts.
// A model that is not listed here cannot be used: the cap cannot be enforced without a price.
//
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-10)
// OpenAI:    https://developers.openai.com/api/docs/pricing (read 2026-10-10; short-context rates, prompts up to 272K tokens)
//
// Cost in micro-USD of `n` tokens at `p` USD per million tokens is exactly n * p.
import type { AiProviderName } from '../ports/ai-execution.js';

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Higher rates once a prompt exceeds `overInputTokens` (the whole request is priced at the higher rate). */
  longContext?: { overInputTokens: number; inputUsdPerMTok: number; outputUsdPerMTok: number };
}

export const PRICES: Record<AiProviderName, Record<string, ModelPrice>> = {
  anthropic: {
    'claude-opus-5-5': { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
    'claude-sonnet-5-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    'claude-haiku-5-5': {
      inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5,
      longContext: { overInputTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
    },
    'claude-opus-5': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    'claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    'claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    'claude-fable-5-1': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  },
  openai: {
    'gpt-6-astra': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
    'gpt-6.1-sol': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    'gpt-6-sol': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    'gpt-6-luna': { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
    'gpt-5.6-sol': { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
    'gpt-5.6-terra': { inputUsdPerMTok: 2, outputUsdPerMTok: 12 },
    'gpt-5.6-luna': { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 },
  },
};

export function priceOf(provider: AiProviderName, model: string): ModelPrice | null {
  return PRICES[provider][model] ?? null;
}

/** Cost in micro-USD (integer, rounded up) of the given token counts. */
export function costMicroUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const tier = price.longContext && inputTokens > price.longContext.overInputTokens ? price.longContext : price;
  return Math.ceil(inputTokens * tier.inputUsdPerMTok + outputTokens * tier.outputUsdPerMTok);
}

export const microToUsd = (micro: number): number => Math.round(micro) / 1_000_000;
export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);

/**
 * Local input-token estimate. Nothing is sent to a provider before execute, so no provider tokenizer is used.
 * One token per three UTF-8 bytes overestimates typical English (about four characters per token) and
 * covers most other scripts; a fixed allowance covers the output schema and message framing.
 */
export function estimateInputTokens(promptText: string): number {
  return Math.ceil(Buffer.byteLength(promptText, 'utf8') / 3) + 400;
}
