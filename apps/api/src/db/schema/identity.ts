// Owner tokens (ADR-0004, ADR-0009). Changing this file is a gated change. Sign-in users, sessions and
// password hashes belong to Better Auth (schema/auth.ts). Token secrets are never stored: only the SHA-256 of
// a random 32-byte secret. Foreign keys to actor and workspace cascade so a restore that replaces the empty
// bootstrap workspace (modules/backup) also removes its tokens.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actor, workspace } from './index.js';

/** A scoped, expiring, revocable owner token. It acts as its own agent_token actor, tied to the owner. */
export const ownerToken = pgTable('owner_token', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  /** The agent_token actor this token acts as (attribution of everything it proposes). */
  actorId: uuid('actor_id').notNull().references(() => actor.id, { onDelete: 'cascade' }),
  /** The owner who created it; the token stops working when this person is revoked. */
  ownerActorId: uuid('owner_actor_id').notNull().references(() => actor.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** First characters of the secret (`poii_xxxxxx`), safe to display so the owner can recognise a token. */
  secretPrefix: text('secret_prefix').notNull(),
  secretSha256: text('secret_sha256').notNull(),
  scopes: text('scopes').array().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [
  uniqueIndex('owner_token_secret_unique').on(table.secretSha256),
  uniqueIndex('owner_token_actor_unique').on(table.actorId),
  index('owner_token_workspace_idx').on(table.workspaceId),
  check('owner_token_scopes_valid', sql`cardinality(${table.scopes}) > 0 AND ${table.scopes} <@ ARRAY['read','propose']::text[]`),
]);

export type OwnerTokenRow = typeof ownerToken.$inferSelect;
