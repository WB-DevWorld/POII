// Identity port (ADR-0004, ADR-0009): resolves every request to an actor and its workspace. No module reads
// sessions or tokens itself. Signing in and out, revoking sessions and changing the password are Better
// Auth's own HTTP endpoints under /v1/auth (local-signin), not members of this port.
import type { ActorRow, WorkspaceRow } from '../db/types.js';

export interface IdentityRequest {
  headers: Record<string, string | string[] | undefined>;
  /** HTTP method; adapters use it for CSRF checks on cookie-authenticated mutations. */
  method?: string;
}

export interface ResolvedIdentity {
  actor: ActorRow;
  workspace: WorkspaceRow;
  /** How the request was authenticated. */
  via?: 'local-owner' | 'session' | 'token';
}

export interface IdentityPort {
  readonly name: string;
  resolve(request: IdentityRequest): Promise<ResolvedIdentity>;
  /** Drops any cached resolution (after a restore replaced the workspace). */
  invalidate(): void;
  /** True when requests need a credential (sign-in session or token); absent or false for local-owner. */
  readonly requiresSignIn?: boolean;
}
