import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActorRow, WorkspaceRow } from '../db/types.js';
import { AppError } from './errors.js';

/** Who is acting, in which workspace, for which request. Every service method takes one. */
export interface RequestContext {
  actor: ActorRow;
  workspace: Pick<WorkspaceRow, 'id' | 'name'>;
  requestId: string;
}

export interface PoiiRequest {
  method: string;
  originalUrl?: string;
  url: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  requestId?: string;
  poii?: RequestContext;
}

export interface PoiiResponse {
  statusCode: number;
  status(code: number): PoiiResponse;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
  json(body: unknown): unknown;
  end(): unknown;
}

/** The request context resolved by the identity port (see ContextInterceptor). */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext => {
  const request = context.switchToHttp().getRequest<PoiiRequest>();
  if (!request.poii) throw new AppError(500, 'internal', 'Request context was not resolved');
  return request.poii;
});

export function headerValue(request: PoiiRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestPath(request: PoiiRequest): string {
  const url = request.originalUrl ?? request.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
