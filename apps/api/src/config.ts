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
  };
}
