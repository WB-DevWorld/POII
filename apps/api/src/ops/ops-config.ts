// Settings for operations (#16): build metadata for /health/version and the backup runner's target.
// Read from the environment separately from config.ts so the API's own settings stay unchanged.
import { fileURLToPath } from 'node:url';
import { LocalDirTarget, S3Target, type BackupTarget } from './backup-target.js';

export interface BackupSettings {
  target: 'local' | 's3';
  keep: number;
  localDir: string | null;
  s3: {
    endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; prefix: string;
    /** POII_BACKUP_S3_TIMEOUT_MS; null keeps the defaults (10 min PUT, 60 s otherwise). */
    timeoutMs: number | null;
  } | null;
}

export interface BuildInfo {
  /** BUILD_TIME, if the image was built with it; null otherwise. */
  builtAt: string | null;
  /** Directory holding the shipped migrations (apps/api/drizzle). */
  migrationsDir: string;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    builtAt: env.BUILD_TIME?.trim() || null,
    migrationsDir: env.POII_MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url)),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function backupSettings(env: NodeJS.ProcessEnv = process.env): BackupSettings {
  const target = env.POII_BACKUP_TARGET?.trim() || 'local';
  if (target !== 'local' && target !== 's3') throw new Error(`Unsupported POII_BACKUP_TARGET: ${target} (local or s3)`);
  const keepRaw = env.POII_BACKUP_KEEP?.trim() || '30';
  const keep = Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`POII_BACKUP_KEEP must be a whole number of at least 1, got ${keepRaw}`);
  if (target === 'local') {
    return { target, keep, localDir: required(env, 'POII_BACKUP_LOCAL_DIR'), s3: null };
  }
  let prefix = env.POII_BACKUP_S3_PREFIX ?? 'poii/';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  if (prefix.startsWith('/')) throw new Error('POII_BACKUP_S3_PREFIX must not start with a slash');
  const timeoutRaw = env.POII_BACKUP_S3_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : null;
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
    throw new Error(`POII_BACKUP_S3_TIMEOUT_MS must be a whole number of milliseconds of at least 1000, got ${timeoutRaw}`);
  }
  return {
    target, keep, localDir: null,
    s3: {
      endpoint: required(env, 'POII_BACKUP_S3_ENDPOINT'),
      bucket: required(env, 'POII_BACKUP_S3_BUCKET'),
      accessKeyId: required(env, 'POII_BACKUP_S3_ACCESS_KEY'),
      secretAccessKey: required(env, 'POII_BACKUP_S3_SECRET_KEY'),
      region: env.POII_BACKUP_S3_REGION?.trim() || 'us-east-1',
      prefix,
      timeoutMs,
    },
  };
}

export function createBackupTarget(settings: BackupSettings, fetchImpl?: typeof fetch): BackupTarget {
  if (settings.target === 'local') return new LocalDirTarget(settings.localDir!);
  return new S3Target({ ...settings.s3!, fetch: fetchImpl });
}
