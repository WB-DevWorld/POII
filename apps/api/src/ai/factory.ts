// #13 AI: chooses the AI-execution adapter from configuration. A provider is available only when
// POII_AI_ENABLED=true, its API key is set and its model has a price (the cap needs one). With no available
// provider the `off` adapter answers every AI endpoint with 503 ai_disabled.
import { AnthropicAiExecution } from '../adapters/anthropic.ai-execution.js';
import { OffAiExecution } from '../adapters/off.ai-execution.js';
import { OpenAiAiExecution } from '../adapters/openai.ai-execution.js';
import type { Settings } from '../config.js';
import type { Db } from '../db/client.js';
import type { AiExecutionPort, AiProviderName, AiProviderStatus, FetchLike } from '../ports/ai-execution.js';
import { aiProviderNames } from '../ports/ai-execution.js';
import { GatedAiExecution, type ProviderRegistration } from './execution.js';
import { priceOf } from './pricing.js';

export function providerStatuses(settings: Settings): AiProviderStatus[] {
  return aiProviderNames.map(provider => {
    const s = settings.ai[provider];
    const price = priceOf(provider, s.model);
    const reason = !settings.aiEnabled ? 'POII_AI_ENABLED is not true'
      : !s.apiKey ? `${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is not set`
        : !price ? `model ${s.model} is not in the price table, so the cap cannot be enforced`
          : null;
    return {
      provider,
      configured: reason === null,
      model: s.model,
      reason,
      monthlyCapUsd: s.monthlyCapUsd,
      pricing: price ? { inputUsdPerMTok: price.inputUsdPerMTok, outputUsdPerMTok: price.outputUsdPerMTok } : null,
    };
  });
}

export function createAiExecution(settings: Settings, db: Db, fetchImpl: FetchLike = (input, init) => fetch(input, init)): AiExecutionPort {
  if (!settings.aiEnabled) return new OffAiExecution();
  const statuses = providerStatuses(settings);
  const registrations = new Map<AiProviderName, ProviderRegistration>();
  for (const status of statuses) {
    if (!status.configured) continue;
    const s = settings.ai[status.provider];
    const apiKey = s.apiKey!;
    registrations.set(status.provider, {
      provider: status.provider,
      model: s.model,
      price: priceOf(status.provider, s.model)!,
      capMicro: Math.round(s.monthlyCapUsd * 1_000_000),
      create: status.provider === 'anthropic'
        ? () => new AnthropicAiExecution({ apiKey, model: s.model, fetch: fetchImpl })
        : () => new OpenAiAiExecution({ apiKey, model: s.model, fetch: fetchImpl }),
    });
  }
  if (!registrations.size) return new OffAiExecution();
  return new GatedAiExecution(db, settings, registrations, statuses);
}
