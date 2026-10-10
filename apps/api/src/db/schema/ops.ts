// Operational tables (#16). Not part of the workspace data model and never part of a poii.backup document:
// a restore into an empty install starts with an empty run history. No foreign keys to workspace data, so a
// restore (which replaces the bootstrap workspace) never trips over them.
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One row per run of the backup runner (apps/api/src/backup-cli.ts). */
export const opsBackupRun = pgTable('ops_backup_run', {
  id: uuid('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  /** `local` or `s3`. */
  target: text('target').notNull(),
  /** Object key (S3) or file name (local) of the poii.backup document; null until it was written. */
  objectKey: text('object_key'),
  byteLength: bigint('byte_length', { mode: 'number' }),
  /** SHA-256 of the written bytes. */
  sha256: text('sha256'),
  status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
  error: text('error'),
  workspaceId: uuid('workspace_id'),
  exportRunId: uuid('export_run_id'),
}, table => [
  check('ops_backup_run_status', sql`${table.status} IN ('running', 'succeeded', 'failed')`),
  index('ops_backup_run_started_idx').on(table.startedAt),
]);
