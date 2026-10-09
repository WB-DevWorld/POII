// Identity port (ADR-0004): resolves every request to an actor and its workspace. No module reads
// sessions or tokens itself.
import type { ActorRow, WorkspaceRow } from '../db/types.js';

export interface IdentityRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface ResolvedIdentity {
  actor: ActorRow;
  workspace: WorkspaceRow;
}

export interface IdentityPort {
  readonly name: string;
  resolve(request: IdentityRequest): Promise<ResolvedIdentity>;
  /** Drops any cached resolution (after a restore replaced the workspace). */
  invalidate(): void;
}
