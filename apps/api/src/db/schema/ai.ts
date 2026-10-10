// #13 AI tables (ADR-0007). Changing this file is a gated change. Migration: drizzle/0003_ai_usage.sql.
// Previews keep no prompt text: execute rebuilds the prompt from the immutable revision and refuses unless
// its sha256 equals the previewed one. Usage rows are the cap ledger and survive source deletion.
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { actor, source, sourceRevision, workspace } from './index.js';

/** One preview: what would be sent, to whom, at what estimated cost, until when. Single use. */
export const aiPreview = pgTable('ai_preview', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
  createdByActorId: uuid('created_by_actor_id').notNull().references(() => actor.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  sourceId: uuid('source_id').notNull().references(() => source.id, { onDelete: 'cascade' }),
  revisionId: uuid('revision_id').notNull().references(() => sourceRevision.id, { onDelete: 'cascade' }),
  startChar: integer('start_char').notNull(),
  endChar: integer('end_char').notNull(),
  recordIds: jsonb('record_ids').$type<string[]>().notNull().default([]),
  promptSha256: text('prompt_sha256').notNull(),
  promptChars: integer('prompt_chars').notNull(),
  inputTokensEstimate: integer('input_tokens_estimate').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  estimatedCostMicroUsd: bigint('estimated_cost_micro_usd', { mode: 'number' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp('executed_at', { withTimezone: true }),
}, table => [
  index('ai_preview_workspace_idx').on(table.workspaceId),
  check('ai_preview_provider_check', sql`${table.provider} IN ('anthropic', 'openai')`),
]);

/**
 * The cap ledger: one row per provider call. `reserved` rows count their reservation against the month's cap
 * until settled; `settled` rows count their actual cost (from the provider's reported usage).
 */
export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
  actorId: uuid('actor_id').references(() => actor.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** Calendar month in UTC, YYYY-MM. */
  month: text('month').notNull(),
  /** The preview this call executed. No foreign key: previews go with their source, the ledger stays. */
  previewId: uuid('preview_id').notNull(),
  promptSha256: text('prompt_sha256').notNull(),
  state: text('state').notNull().default('reserved'),
  outcome: text('outcome'),
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
  actualMicroUsd: bigint('actual_micro_usd', { mode: 'number' }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, table => [
  index('ai_usage_provider_month_idx').on(table.provider, table.month),
  check('ai_usage_provider_check', sql`${table.provider} IN ('anthropic', 'openai')`),
  check('ai_usage_state_check', sql`${table.state} IN ('reserved', 'settled')`),
]);
