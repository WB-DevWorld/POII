// Backup runner entry point (#16): `pnpm --filter @poii/api backup:run` locally, `node dist/backup-cli.js` in the image.
// Reads DATABASE_URL, POII_STORAGE_ADAPTER/POII_STORAGE_LOCAL_DIR (original bytes) and POII_BACKUP_* (target,
// retention); writes one poii.backup v1 document plus latest.json; prints one JSON line per step; exits 1 on any
// failure. Only the storage adapter is constructed: no identity adapter, so no web URL, session or token settings are
// needed (the run acts as the workspace owner read from the database, see ops/backup-runner.ts).
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { config, type Settings } from './config.js';
import { LocalFsStorage } from './adapters/local-fs.storage.js';
import { createDb } from './db/client.js';
import { BackupService } from './modules/backup/backup.service.js';
import type { IdentityPort } from './ports/identity.js';
import type { StoragePort } from './ports/storage.js';
import { runBackup, type BackupRunResult } from './ops/backup-runner.js';
import { backupSettings, createBackupTarget } from './ops/ops-config.js';

/** The storage adapter the API would use for these settings. Keep in step with createPorts in app.module.ts. */
function storageFor(settings: Settings): StoragePort {
  switch (settings.storageAdapter) {
    case 'local':
      return new LocalFsStorage(settings.storageLocalDir);
    default:
      throw new Error(`The backup runner does not support POII_STORAGE_ADAPTER=${String(settings.storageAdapter)}`);
  }
}

/** BackupService only touches identity on restore; the runner never restores. */
const noIdentity: IdentityPort = {
  name: 'none',
  resolve: () => Promise.reject(new Error('The backup runner resolves no requests')),
  invalidate: () => undefined,
};

export async function main(env: NodeJS.ProcessEnv = process.env, log = (event: Record<string, unknown>) => console.info(JSON.stringify(event))): Promise<BackupRunResult> {
  const settings = config(env);
  const backup = backupSettings(env);
  const db = createDb(settings.databaseUrl, 2);
  try {
    const backupService = new BackupService(db, storageFor(settings), noIdentity);
    return await runBackup({ db, backupService, target: createBackupTarget(backup), keep: backup.keep, log });
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await main();
    process.exitCode = result.status === 'succeeded' && !result.error ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ event: 'backup.error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
