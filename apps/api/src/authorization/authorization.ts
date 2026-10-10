// The single authorization code path (ADR-0004, docs/api.md capability table).
// person with authority: everything; agent_token: read + propose; every other actor: nothing.
import { AppError } from '../common/errors.js';
import type { ActorRow } from '../db/types.js';

export type Capability = 'read' | 'propose' | 'confirm' | 'delete';
export const capabilities: readonly Capability[] = ['read', 'propose', 'confirm', 'delete'];

export type AuthorizableActor = Pick<ActorRow, 'kind' | 'authority' | 'revokedAt'>;

export function can(actor: AuthorizableActor, capability: Capability): boolean {
  if (actor.revokedAt) return false;
  if (actor.kind === 'person' && actor.authority) return true;
  if (actor.kind === 'agent_token') return capability === 'read' || capability === 'propose';
  return false;
}

export function capabilitiesOf(actor: AuthorizableActor): Record<Capability, boolean> {
  return { read: can(actor, 'read'), propose: can(actor, 'propose'), confirm: can(actor, 'confirm'), delete: can(actor, 'delete') };
}

/**
 * Throws 403 unless the actor holds the capability. An actor that can otherwise use the API but lacks
 * authority gets `authority_required`; an actor that cannot use the API at all gets `forbidden`.
 */
export function requireCapability(actor: AuthorizableActor, capability: Capability): void {
  if (can(actor, capability)) return;
  if (actor.revokedAt) throw new AppError(403, 'forbidden', 'This actor has been revoked');
  if (can(actor, 'read')) {
    throw new AppError(403, 'authority_required', `This action needs a person with authority (capability: ${capability})`);
  }
  throw new AppError(403, 'forbidden', `Actor kind ${actor.kind} may not use this capability (${capability})`);
}
