import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { mergeMap, of, type Observable } from 'rxjs';
import { v7 } from 'uuid';
import type { Db } from '../db/client.js';
import { idempotencyKey } from '../db/schema/index.js';
import type { IdentityPort } from '../ports/identity.js';
import { badRequest, conflict } from './errors.js';
import { headerValue, requestPath, type PoiiRequest, type PoiiResponse } from './request-context.js';
import { DB, IDENTITY_PORT } from './tokens.js';
import { canonicalJson, sha256Hex } from './util.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Restore is idempotent by itself and replaces the workspace; backups are too large to keep as replies.
 * AI previews carry source text in their reply and must never be stored as a replay (#13 AI).
 */
const NOT_IDEMPOTENT_BY_KEY = new Set(['/v1/restore', '/v1/backup', '/v1/ai/preview']);

/**
 * For every /v1 request: resolves the actor and workspace through the identity port, then applies
 * Idempotency-Key semantics to mutating calls (same key + same body → the stored first response;
 * same key + different body → 409 idempotency_mismatch).
 */
@Injectable()
export class ContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(DB) private readonly db: Db,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<PoiiRequest>();
    const res = context.switchToHttp().getResponse<PoiiResponse>();
    const path = requestPath(req);
    if (path !== '/v1' && !path.startsWith('/v1/')) return next.handle();

    const resolved = await this.identity.resolve({ headers: req.headers });
    const requestId = req.requestId ?? v7();
    req.poii = { actor: resolved.actor, workspace: { id: resolved.workspace.id, name: resolved.workspace.name }, requestId };

    const method = req.method.toUpperCase();
    const key = headerValue(req, 'idempotency-key');
    if (key === undefined || !MUTATING.has(method) || NOT_IDEMPOTENT_BY_KEY.has(path.replace(/\/+$/, '').toLowerCase())) return next.handle();
    if (!key || key.length > 200) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 1 to 200 characters');

    const workspaceId = resolved.workspace.id;
    const storedKey = `${workspaceId}:${key}`;
    const requestSha256 = sha256Hex(canonicalJson({ method, path, body: req.body ?? null }));
    const existing = (await this.db.orm.select().from(idempotencyKey)
      .where(and(eq(idempotencyKey.key, storedKey), eq(idempotencyKey.workspaceId, workspaceId))))[0];
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        throw conflict('idempotency_mismatch', 'This Idempotency-Key was used with a different request');
      }
      res.status(existing.status);
      res.setHeader('idempotent-replay', 'true');
      return of(existing.status === 204 ? undefined : existing.response);
    }
    return next.handle().pipe(mergeMap(async body => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        await this.db.orm.insert(idempotencyKey).values({
          key: storedKey, workspaceId, requestSha256, status, response: (body ?? {}) as object,
        }).onConflictDoNothing();
      }
      return body;
    }));
  }
}
