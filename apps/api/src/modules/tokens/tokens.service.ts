// Owner tokens (ADR-0004, ADR-0009): scoped (read, propose), expiring, revocable, stored as SHA-256 of a
// random secret. Each token acts as its own agent_token actor so everything it proposes is attributed to it.
import { Inject, Injectable } from '@nestjs/common';
import type { CreateTokenRequest, CreatedTokenResponse, TokenView } from '@poii/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { newTokenSecret, sha256 } from '../../adapters/identity-secrets.js';
import { requireAccessManagement } from '../../authorization/authorization.js';
import { audit } from '../../common/audit.js';
import { badRequest, notFound } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB } from '../../common/tokens.js';
import { iso, newId } from '../../common/util.js';
import type { Db } from '../../db/client.js';
import { actor, ownerToken, type OwnerTokenRow } from '../../db/schema/index.js';

type CreateToken = z.output<typeof CreateTokenRequest>;

/** Longest allowed token lifetime. */
export const MAX_TOKEN_DAYS = 366;

export function toTokenView(row: OwnerTokenRow, now = new Date()): TokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes.filter((s): s is 'read' | 'propose' => s === 'read' || s === 'propose'),
    secretPrefix: row.secretPrefix,
    actorId: row.actorId,
    ownerActorId: row.ownerActorId,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active',
  };
}

@Injectable()
export class TokensService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(ctx: RequestContext, input: CreateToken): Promise<CreatedTokenResponse> {
    requireAccessManagement(ctx.actor);
    const now = Date.now();
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= now + 60_000) throw badRequest('invalid_expiry', 'expiresAt must be at least a minute in the future');
    if (expiresAt.getTime() > now + MAX_TOKEN_DAYS * 86_400_000) throw badRequest('invalid_expiry', `Tokens expire within ${MAX_TOKEN_DAYS} days`);
    const scopes = (['read', 'propose'] as const).filter(s => input.scopes.includes(s));
    const secret = newTokenSecret();
    const id = newId();
    const row = await this.db.orm.transaction(async tx => {
      const agent = (await tx.insert(actor).values({
        id: newId(), workspaceId: ctx.workspace.id, kind: 'agent_token', displayName: `Token: ${input.name}`, authority: null,
        details: { tokenId: id, scopes, ownerActorId: ctx.actor.id },
      }).returning())[0]!;
      const created = (await tx.insert(ownerToken).values({
        id, workspaceId: ctx.workspace.id, actorId: agent.id, ownerActorId: ctx.actor.id, name: input.name,
        secretPrefix: secret.slice(0, 12), secretSha256: sha256(secret), scopes: [...scopes], expiresAt,
      }).returning())[0]!;
      await audit(tx, ctx, 'token.created', 'owner_token', id, { scopes, expiresAt: expiresAt.toISOString(), actorId: agent.id });
      return created;
    });
    return { token: toTokenView(row), secret };
  }

  async list(ctx: RequestContext): Promise<TokenView[]> {
    requireAccessManagement(ctx.actor);
    const rows = await this.db.orm.select().from(ownerToken).where(eq(ownerToken.workspaceId, ctx.workspace.id))
      .orderBy(desc(ownerToken.createdAt), desc(ownerToken.id));
    const now = new Date();
    return rows.map(r => toTokenView(r, now));
  }

  /** Immediate: the next request with this token gets 401. Revoking twice is a no-op. */
  async revoke(ctx: RequestContext, id: string): Promise<void> {
    requireAccessManagement(ctx.actor);
    await this.db.orm.transaction(async tx => {
      const row = (await tx.select().from(ownerToken).where(and(eq(ownerToken.id, id), eq(ownerToken.workspaceId, ctx.workspace.id))))[0];
      if (!row) throw notFound('Token');
      if (row.revokedAt) return;
      const at = new Date();
      await tx.update(ownerToken).set({ revokedAt: at }).where(and(eq(ownerToken.id, id), isNull(ownerToken.revokedAt)));
      await tx.update(actor).set({ revokedAt: at }).where(and(eq(actor.id, row.actorId), isNull(actor.revokedAt)));
      await audit(tx, ctx, 'token.revoked', 'owner_token', id, {});
    });
  }
}
