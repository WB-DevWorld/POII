// The single authorization code path (ADR-0004, ADR-0009, docs/api.md capability table).
// person with authority: everything; agent_token: read and/or propose, as its scopes allow; every other actor: nothing.
// ai_execute (#13): sending text to an AI provider spends budget; only a person with authority, never a token.
// Managing access (creating and revoking owner tokens) is reserved to the owner person.
import { AppError } from '../common/errors.js';
import type { ActorRow } from '../db/types.js';

export type Capability = 'read' | 'propose' | 'confirm' | 'delete' | 'ai_execute';
export const capabilities: readonly Capability[] = ['read', 'propose', 'confirm', 'delete', 'ai_execute'];

/** Owner-token scopes. `propose` implies `read`. */
export type TokenScope = 'read' | 'propose';

export type AuthorizableActor = Pick<ActorRow, 'kind' | 'authority' | 'revokedAt'> & { details?: Record<string, unknown> | null };

/**
 * The scopes an agent_token actor carries. The token identity adapter always sets them from the token row.
 * An agent_token actor without a scopes array has no scopes at all (fail closed).
 */
export function tokenScopes(actor: AuthorizableActor): TokenScope[] {
  const raw = actor.details?.scopes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is TokenScope => s === 'read' || s === 'propose');
}

export function can(actor: AuthorizableActor, capability: Capability): boolean {
  if (actor.revokedAt) return false;
  if (actor.kind === 'person' && actor.authority) return true;
  if (actor.kind === 'agent_token') {
    const scopes = tokenScopes(actor);
    if (capability === 'read') return scopes.includes('read') || scopes.includes('propose');
    if (capability === 'propose') return scopes.includes('propose');
    return false;
  }
  return false;
}

export function capabilitiesOf(actor: AuthorizableActor): Record<Capability, boolean> {
  return {
    read: can(actor, 'read'), propose: can(actor, 'propose'), confirm: can(actor, 'confirm'), delete: can(actor, 'delete'),
    ai_execute: can(actor, 'ai_execute'),
  };
}

/**
 * Throws 403 unless the actor holds the capability. An actor that can otherwise use the API but lacks
 * authority gets `authority_required`; a token whose scopes do not cover a read or propose call gets
 * `scope_required`; an actor that cannot use the API at all gets `forbidden`.
 */
export function requireCapability(actor: AuthorizableActor, capability: Capability): void {
  if (can(actor, capability)) return;
  if (actor.revokedAt) throw new AppError(403, 'forbidden', 'This actor has been revoked');
  if (actor.kind === 'agent_token' && (capability === 'read' || capability === 'propose') && can(actor, 'read')) {
    throw new AppError(403, 'scope_required', `This token's scopes do not include ${capability}`);
  }
  if (can(actor, 'read')) {
    throw new AppError(403, 'authority_required', `This action needs a person with authority (capability: ${capability})`);
  }
  throw new AppError(403, 'forbidden', `Actor kind ${actor.kind} may not use this capability (${capability})`);
}

/** Creating, listing and revoking owner tokens: only the owner person, never a token. */
export function canManageAccess(actor: AuthorizableActor): boolean {
  return !actor.revokedAt && actor.kind === 'person' && actor.authority === 'owner';
}

export function requireAccessManagement(actor: AuthorizableActor): void {
  if (canManageAccess(actor)) return;
  if (actor.revokedAt) throw new AppError(403, 'forbidden', 'This actor has been revoked');
  if (can(actor, 'read')) throw new AppError(403, 'owner_required', 'Only the owner can manage tokens');
  throw new AppError(403, 'forbidden', `Actor kind ${actor.kind} may not manage tokens`);
}
