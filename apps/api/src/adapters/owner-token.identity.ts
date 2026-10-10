// Owner tokens on top of any identity adapter (ADR-0004, ADR-0009). A request with `Authorization: Bearer
// poii_…` resolves to the token's own agent_token actor, carrying the token's scopes; every other request goes
// to the wrapped adapter (local-owner or local-signin). The token row is read on every request, so expiry
// and revocation take effect immediately. An Authorization header never falls through to the wrapped adapter.
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors.js';
import type { Db } from '../db/client.js';
import { actor, ownerToken, workspace } from '../db/schema/index.js';
import type { IdentityPort, IdentityRequest, ResolvedIdentity } from '../ports/identity.js';
import { bearerSecret, isTokenSecret, sameDigest, sha256 } from './identity-secrets.js';

const invalid = () => new AppError(401, 'invalid_token', 'The token is not valid');
const LAST_USED_EVERY_MS = 60_000;

export class OwnerTokenIdentity implements IdentityPort {
  constructor(private readonly db: Db, readonly inner: IdentityPort) {}

  get name(): string {
    return this.inner.name;
  }

  get requiresSignIn(): boolean {
    return this.inner.requiresSignIn === true;
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  async resolve(request: IdentityRequest): Promise<ResolvedIdentity> {
    const secret = bearerSecret(request);
    if (secret === undefined) return this.inner.resolve(request);
    if (!isTokenSecret(secret)) throw invalid();
    const digest = sha256(secret);
    const owner = alias(actor, 'token_owner');
    const row = (await this.db.orm.select({ token: ownerToken, agent: actor, owner, workspace })
      .from(ownerToken)
      .innerJoin(actor, eq(actor.id, ownerToken.actorId))
      .innerJoin(owner, eq(owner.id, ownerToken.ownerActorId))
      .innerJoin(workspace, eq(workspace.id, ownerToken.workspaceId))
      .where(eq(ownerToken.secretSha256, digest)).limit(1))[0];
    if (!row || !sameDigest(row.token.secretSha256, digest)) throw invalid();
    if (row.token.revokedAt || row.agent.revokedAt) throw new AppError(401, 'token_revoked', 'This token has been revoked');
    if (row.owner.revokedAt) throw new AppError(401, 'token_revoked', 'The owner of this token has been revoked');
    const now = new Date();
    if (row.token.expiresAt.getTime() <= now.getTime()) throw new AppError(401, 'token_expired', 'This token has expired');
    await this.db.orm.update(ownerToken).set({ lastUsedAt: now }).where(and(
      eq(ownerToken.id, row.token.id),
      or(isNull(ownerToken.lastUsedAt), lt(ownerToken.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS))),
    ));
    return {
      actor: {
        ...row.agent,
        // Scopes always come from the token row, never from anything stored on the actor.
        details: { ...row.agent.details, tokenId: row.token.id, ownerActorId: row.token.ownerActorId, scopes: [...row.token.scopes] },
      },
      workspace: row.workspace,
      via: 'token',
    };
  }
}
