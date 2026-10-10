export interface Settings {
  databaseUrl: string;
  port: number;
  version: string;
  identityAdapter: 'local-owner';
  /** ADR-0004: local-owner is refused for a non-loopback WEB_BASE_URL unless this is set deliberately. */
  allowLocalOwnerRemote: boolean;
  ownerDisplayName: string;
  storageAdapter: 'local';
  storageLocalDir: string;
  aiEnabled: boolean;
  webBaseUrl: string;
  ai: AiSettings; // #13 AI
}

export function config(env: NodeJS.ProcessEnv = process.env): Settings {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const identityAdapter = env.POII_IDENTITY_ADAPTER ?? 'local-owner';
  if (identityAdapter !== 'local-owner') throw new Error(`Unsupported POII_IDENTITY_ADAPTER: ${identityAdapter}`);
  const storageAdapter = env.POII_STORAGE_ADAPTER ?? 'local';
  if (storageAdapter !== 'local') throw new Error(`Unsupported POII_STORAGE_ADAPTER: ${storageAdapter}`);
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3001),
    version: env.GIT_SHA ?? 'dev',
    identityAdapter,
    allowLocalOwnerRemote: env.POII_ALLOW_LOCAL_OWNER_REMOTE === 'true',
    ownerDisplayName: env.POII_OWNER_DISPLAY_NAME ?? 'Owner',
    storageAdapter,
    storageLocalDir: env.POII_STORAGE_LOCAL_DIR ?? '.poii-storage',
    aiEnabled: env.POII_AI_ENABLED === 'true',
    webBaseUrl: env.WEB_BASE_URL ?? 'http://localhost:3000',
    ai: aiConfig(env), // #13 AI
  };
}

// #13 AI ----------------------------------------------------------------------------------------------
// AI execution settings (ADR-0007). A provider is available only when POII_AI_ENABLED=true and its key is
// set; otherwise the `off` adapter answers every AI endpoint with 503 ai_disabled. Caps are USD per
// provider per calendar month (UTC), enforced inside POII.
export type AiProviderSetting = 'anthropic' | 'openai';

export interface AiProviderSettings {
  apiKey: string | null;
  model: string;
  monthlyCapUsd: number;
}

export interface AiSettings {
  defaultProvider: AiProviderSetting | null;
  anthropic: AiProviderSettings;
  openai: AiProviderSettings;
  /** Store the prompt text in the audit log (only ever for AI-allowed material). Default false: hash and ids only. */
  logRequestText: boolean;
  previewTtlSeconds: number;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export const AI_DEFAULT_MODELS: Record<AiProviderSetting, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' };

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, integer = true): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${name}: expected ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiSettings {
  const defaultProvider = env.POII_AI_PROVIDER_DEFAULT?.trim() || null;
  if (defaultProvider !== null && defaultProvider !== 'anthropic' && defaultProvider !== 'openai') {
    throw new Error(`Unsupported POII_AI_PROVIDER_DEFAULT: ${defaultProvider}`);
  }
  const key = (name: string) => env[name]?.trim() || null;
  return {
    defaultProvider,
    anthropic: {
      apiKey: key('ANTHROPIC_API_KEY'),
      model: env.POII_AI_ANTHROPIC_MODEL?.trim() || AI_DEFAULT_MODELS.anthropic,
      monthlyCapUsd: numberEnv(env, 'POII_AI_MONTHLY_CAP_USD_ANTHROPIC', 20, 0, 100_000, false),
    },
    openai: {
      apiKey: key('OPENAI_API_KEY'),
      model: env.POII_AI_OPENAI_MODEL?.trim() || AI_DEFAULT_MODELS.openai,
      monthlyCapUsd: numberEnv(env, 'POII_AI_MONTHLY_CAP_USD_OPENAI', 20, 0, 100_000, false),
    },
    logRequestText: env.POII_AI_LOG_REQUEST_TEXT === 'true',
    previewTtlSeconds: numberEnv(env, 'POII_AI_PREVIEW_TTL_SECONDS', 900, 10, 86_400),
    maxInputChars: numberEnv(env, 'POII_AI_MAX_INPUT_CHARS', 100_000, 100, 2_000_000),
    maxOutputTokens: numberEnv(env, 'POII_AI_MAX_OUTPUT_TOKENS', 8_000, 256, 128_000),
    timeoutMs: numberEnv(env, 'POII_AI_TIMEOUT_MS', 600_000, 1_000, 900_000),
  };
}
// end #13 AI ------------------------------------------------------------------------------------------
