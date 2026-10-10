// Append-only audit log: every mutation writes one event in the same transaction.
import { auditEvent } from '../db/schema/index.js';
import type { Exec } from '../db/types.js';
import type { RequestContext } from './request-context.js';
import { newId } from './util.js';

export async function audit(
  exec: Exec,
  ctx: RequestContext,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await exec.insert(auditEvent).values({
    id: newId(),
    workspaceId: ctx.workspace.id,
    actorId: ctx.actor.id,
    action,
    targetType,
    targetId,
    requestId: ctx.requestId,
    details,
  });
}
