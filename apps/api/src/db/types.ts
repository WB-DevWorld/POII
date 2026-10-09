import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type * as schema from './schema/index.js';

/** The ORM itself or a transaction: every repository function accepts either. */
export type Exec = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export type WorkspaceRow = typeof schema.workspace.$inferSelect;
export type ActorRow = typeof schema.actor.$inferSelect;
export type SourceRow = typeof schema.source.$inferSelect;
export type RevisionRow = typeof schema.sourceRevision.$inferSelect;
export type RecordRow = typeof schema.record.$inferSelect;
export type EvidenceRow = typeof schema.recordEvidence.$inferSelect;
export type ApprovalRow = typeof schema.approval.$inferSelect;
export type RecordVersionRow = typeof schema.recordVersion.$inferSelect;
export type TombstoneRow = typeof schema.sourceTombstone.$inferSelect;
export type ExportRunRow = typeof schema.exportRun.$inferSelect;
