import { Inject, Injectable } from '@nestjs/common';
import type { ActorView, CreateActorRequest, MeResponse } from '@poii/contracts';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import type { RequestContext } from '../../common/request-context.js';
import { AI_EXECUTION_PORT, DB, SETTINGS } from '../../common/tokens.js';
import { iso, newId } from '../../common/util.js';
import { capabilitiesOf, requireCapability } from '../../authorization/authorization.js';
import type { Settings } from '../../config.js';
import type { Db } from '../../db/client.js';
import { actor } from '../../db/schema/index.js';
import type { ActorRow } from '../../db/types.js';
import type { AiExecutionPort } from '../../ports/ai-execution.js';

type CreateActor = z.output<typeof CreateActorRequest>;

export function toActorView(row: ActorRow): ActorView {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    authority: row.authority,
    details: row.details,
    revokedAt: iso(row.revokedAt),
  };
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AI_EXECUTION_PORT) private readonly ai: AiExecutionPort,
  ) {}

  me(ctx: RequestContext): MeResponse {
    requireCapability(ctx.actor, 'read');
    const caps = capabilitiesOf(ctx.actor);
    return {
      actor: toActorView(ctx.actor),
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
      capabilities: { canConfirm: caps.confirm, canDelete: caps.delete, canPropose: caps.propose },
      aiEnabled: this.settings.aiEnabled && this.ai.enabled,
    };
  }

  async listActors(ctx: RequestContext): Promise<ActorView[]> {
    requireCapability(ctx.actor, 'read');
    const rows = await this.db.orm.select().from(actor).where(eq(actor.workspaceId, ctx.workspace.id)).orderBy(asc(actor.createdAt), asc(actor.id));
    return rows.map(toActorView);
  }

  /** Persons created here never hold authority; AI assistants exist for attribution only. */
  async createActor(ctx: RequestContext, input: CreateActor): Promise<ActorView> {
    requireCapability(ctx.actor, 'propose');
    const row = await this.db.orm.transaction(async tx => {
      const created = (await tx.insert(actor).values({
        id: newId(), workspaceId: ctx.workspace.id, kind: input.kind, displayName: input.displayName, authority: null, details: input.details,
      }).returning())[0]!;
      await audit(tx, ctx, 'actor.created', 'actor', created.id, { kind: input.kind });
      return created;
    });
    return toActorView(row);
  }
}
