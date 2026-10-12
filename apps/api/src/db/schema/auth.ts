// Better Auth tables for the `local-signin` adapter (ADR-0009). Changing this file is a gated change.
// Shape follows what Better Auth 1.7 expects for the core schema plus the username plugin, with POII's names:
// tables are prefixed `auth_` (Better Auth `modelName`), columns are snake_case in PostgreSQL while the
// TypeScript keys keep Better Auth's field names (the Drizzle adapter addresses columns by key).
// Better Auth owns the rows: password hashes (its scrypt) live in auth_account.password, sessions in
// auth_session. POII only reads auth_user.actor_id to map the signed-in user to its owner actor.
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actor } from './index.js';

const at = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Required by Better Auth; POII stores a synthetic, never-used address (see ADR-0009). */
  email: text('email').notNull().unique('auth_user_email_unique'),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  /** Username plugin: the login, normalized to lower case. */
  username: text('username').unique('auth_user_username_unique'),
  displayUsername: text('display_username'),
  /** The POII actor this user signs in as. Set null when a restore removes that actor; re-attached on next use. */
  actorId: uuid('actor_id').references(() => actor.id, { onDelete: 'set null' }),
}, () => [
  // Owner-only mode: at most one sign-in user per install. Dropping this index is a contract change.
  uniqueIndex('auth_user_single_owner').on(sql`(true)`),
]);

export const authSession = pgTable('auth_session', {
  id: text('id').primaryKey(),
  expiresAt: at('expires_at').notNull(),
  /** The session token Better Auth signs into the cookie. */
  token: text('token').notNull().unique('auth_session_token_unique'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
}, table => [index('auth_session_user_id_idx').on(table.userId)]);

export const authAccount = pgTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: at('access_token_expires_at'),
  refreshTokenExpiresAt: at('refresh_token_expires_at'),
  scope: text('scope'),
  /** Better Auth's scrypt hash for the `credential` provider. */
  password: text('password'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().$onUpdate(() => new Date()),
}, table => [index('auth_account_user_id_idx').on(table.userId)]);

export const authVerification = pgTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: at('expires_at').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [index('auth_verification_identifier_idx').on(table.identifier)]);

/** The schema object handed to Better Auth's Drizzle adapter, keyed by model name. */
export const betterAuthSchema = {
  auth_user: authUser,
  auth_session: authSession,
  auth_account: authAccount,
  auth_verification: authVerification,
};

export type AuthUserRow = typeof authUser.$inferSelect;

// #17 AccessLobby OIDC (ADR-0012) -------------------------------------------------------------------
// POII-owned tables (not Better Auth models). identity_link is the explicit, auditable mapping the AccessLobby
// consumer contract v0.1 asks for: (issuer, sub, person.id) -> the owner's sign-in user and actor. It is
// written only by the explicit "Connect AccessLobby" flow and removed only by "Disconnect" (password required).

export const identityLink = pgTable('identity_link', {
  id: uuid('id').primaryKey(),
  /** The AccessLobby issuer exactly as configured and as named in the ID token's `iss`. */
  issuer: text('issuer').notNull(),
  /** The ID token's `sub`: the issuer's subject, not the durable person ID. */
  subject: text('subject').notNull(),
  /** AccessLobby's durable person ID from `GET /v1/me` (`person.id`). */
  personId: text('person_id').notNull(),
  authUserId: text('auth_user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  /** The POII actor at link time; set null when a restore replaces it and refreshed at the next AccessLobby sign-in. */
  actorId: uuid('actor_id').references(() => actor.id, { onDelete: 'set null' }),
  linkedAt: at('linked_at').notNull().defaultNow(),
  lastSignInAt: at('last_sign_in_at'),
}, table => [
  uniqueIndex('identity_link_issuer_subject_unique').on(table.issuer, table.subject),
  uniqueIndex('identity_link_person_unique').on(table.personId),
  uniqueIndex('identity_link_user_unique').on(table.authUserId),
]);

/** POII sessions created by an AccessLobby sign-in: the ID token (for `id_token_hint`) and the issuer session `sid`. */
export const accessLobbySession = pgTable('accesslobby_session', {
  sessionId: text('session_id').primaryKey().references(() => authSession.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  sid: text('sid'),
  idToken: text('id_token').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
}, table => [index('accesslobby_session_sid_idx').on(table.issuer, table.sid)]);

export type IdentityLinkRow = typeof identityLink.$inferSelect;
// end #17 AccessLobby OIDC --------------------------------------------------------------------------
