// Backup runner entry point (#16): `pnpm --filter @poii/api backup:run` locally, `node dist/backup-cli.js` in the image.
// Reads DATABASE_URL, POII_STORAGE_LOCAL_DIR (original bytes) and POII_BACKUP_* (target, retention); writes one
// poii.backup v1 document plus latest.json; prints one JSON line per step; exits 1 on any failure.
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createPorts } from './app.module.js';
import { createDb } from './db/client.js';
import { BackupService } from './modules/backup/backup.service.js';
import { runBackup, type BackupRunResult } from './ops/backup-runner.js';
import { backupSettings, createBackupTarget } from './ops/ops-config.js';

export async function main(env: NodeJS.ProcessEnv = process.env, log = (event: Record<string, unknown>) => console.info(JSON.stringify(event))): Promise<BackupRunResult> {
  const settings = config(env);
  const backup = backupSettings(env);
  const db = createDb(settings.databaseUrl, 2);
  try {
    const ports = createPorts(settings, db);
    const backupService = new BackupService(db, ports.storage, ports.identity);
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
