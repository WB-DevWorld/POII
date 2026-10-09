// `local-owner` identity adapter (ADR-0004): every request is the single owner of the single workspace.
// On first use it creates the workspace, the owner person (authority owner) and a system actor.
// Bootstrap is serialized by an advisory lock and is idempotent; the result is cached in memory.
import { and, asc, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Settings } from '../config.js';
import type { Db } from '../db/client.js';
import { actor, auditEvent, workspace } from '../db/schema/index.js';
import { newId } from '../common/util.js';
import type { IdentityPort, IdentityRequest, ResolvedIdentity } from '../ports/identity.js';

export const OWNER_WORKSPACE_NAME = 'Owner workspace';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export class LocalOwnerIdentity implements IdentityPort {
  readonly name = 'local-owner';
  private cached: Promise<ResolvedIdentity> | undefined;

  constructor(private readonly db: Db, private readonly settings: Pick<Settings, 'ownerDisplayName' | 'webBaseUrl' | 'allowLocalOwnerRemote'>) {
    if (!isLoopbackUrl(settings.webBaseUrl) && !settings.allowLocalOwnerRemote) {
      throw new Error(
        'The local-owner identity adapter is refused for a non-loopback WEB_BASE_URL; set POII_ALLOW_LOCAL_OWNER_REMOTE=true deliberately (ADR-0004)',
      );
    }
  }

  resolve(_request: IdentityRequest): Promise<ResolvedIdentity> {
    if (!this.cached) {
      this.cached = this.bootstrap().catch(error => {
        this.cached = undefined;
        throw error;
      });
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private bootstrap(): Promise<ResolvedIdentity> {
    return this.db.orm.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('poii.local-owner.bootstrap'))`);
      let ws = (await tx.select().from(workspace).orderBy(asc(workspace.createdAt), asc(workspace.id)).limit(1))[0];
      const created: string[] = [];
      if (!ws) {
        ws = (await tx.insert(workspace).values({ id: newId(), name: OWNER_WORKSPACE_NAME }).returning())[0]!;
        created.push('workspace');
      }
      let system = (await tx.select().from(actor)
        .where(and(eq(actor.workspaceId, ws.id), eq(actor.kind, 'system')))
        .orderBy(asc(actor.createdAt), asc(actor.id)).limit(1))[0];
      if (!system) {
        system = (await tx.insert(actor).values({
          id: newId(), workspaceId: ws.id, kind: 'system', displayName: 'POII system', authority: null, details: {},
        }).returning())[0]!;
        created.push('system');
      }
      let owner = (await tx.select().from(actor)
        .where(and(eq(actor.workspaceId, ws.id), eq(actor.kind, 'person'), eq(actor.authority, 'owner'), isNull(actor.revokedAt)))
        .orderBy(asc(actor.createdAt), asc(actor.id)).limit(1))[0];
      if (!owner) {
        owner = (await tx.insert(actor).values({
          id: newId(), workspaceId: ws.id, kind: 'person', displayName: this.settings.ownerDisplayName, authority: 'owner',
          details: { identityAdapter: 'local-owner' },
        }).returning())[0]!;
        created.push('owner');
      }
      if (created.length) {
        await tx.insert(auditEvent).values({
          id: newId(), workspaceId: ws.id, actorId: system.id, action: 'identity.bootstrap', targetType: 'workspace',
          targetId: ws.id, details: { adapter: this.name, created },
        });
      }
      return { actor: owner, workspace: ws };
    });
  }
}
