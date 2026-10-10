import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiError } from '@poii/contracts';
import { v7 } from 'uuid';
import { AppError } from './errors.js';
import type { PoiiRequest, PoiiResponse } from './request-context.js';

const HTTP_CODES: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict',
  413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'unprocessable', 429: 'too_many_requests',
};

const isZodError = (e: unknown): e is { issues: unknown[] } =>
  !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues);

/** Postgres errors arrive directly or wrapped (DrizzleQueryError.cause). */
function pgCode(e: unknown): string | undefined {
  for (let current = e, depth = 0; current && typeof current === 'object' && depth < 3; current = (current as { cause?: unknown }).cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

function pgConstraint(e: unknown): string | undefined {
  for (let current = e, depth = 0; current && typeof current === 'object' && depth < 3; current = (current as { cause?: unknown }).cause, depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
  }
  return undefined;
}

export function toErrorBody(exception: unknown, requestId: string): { status: number; body: ApiError } {
  if (exception instanceof AppError) {
    return { status: exception.status, body: { error: exception.code, message: exception.message, requestId, ...(exception.details !== undefined ? { details: exception.details } : {}) } };
  }
  if (isZodError(exception)) {
    return { status: 400, body: { error: 'validation_failed', message: 'The request did not match the contract', requestId, details: exception.issues } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, body: { error: HTTP_CODES[status] ?? `http_${status}`, message: exception.message, requestId } };
  }
  const code = pgCode(exception);
  if (code === '23505' || code === '23503') {
    console.warn(JSON.stringify({ event: 'api.db_conflict', requestId, code, constraint: pgConstraint(exception) }));
    return { status: 409, body: { error: 'conflict', message: 'The change conflicts with existing data', requestId } };
  }
  if (code === '22P02' || code === '22007' || code === '22008') {
    return { status: 400, body: { error: 'invalid_input', message: 'A value could not be interpreted', requestId } };
  }
  // Express/body-parser errors carry a 4xx status and are safe to expose.
  const status = (exception as { status?: unknown; statusCode?: unknown } | null)?.status ?? (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && (exception as { expose?: unknown }).expose !== false) {
    return { status, body: { error: HTTP_CODES[status] ?? `http_${status}`, message: (exception as Error).message ?? 'Bad request', requestId } };
  }
  return { status: 500, body: { error: 'internal', message: 'Internal error', requestId } };
}

/** Server-side log line. Query errors carry their parameters (possibly source text) in the message: never log those. */
function describeForLog(exception: unknown): string {
  if (exception && typeof exception === 'object' && 'query' in exception && 'params' in exception) {
    const cause = (exception as { cause?: { message?: string; code?: string } }).cause;
    return `DatabaseQueryError: ${cause?.code ?? ''} ${cause?.message ?? ''}`.trim();
  }
  return exception instanceof Error ? `${exception.name}: ${exception.stack ?? exception.message}` : 'Non-error thrown';
}

/** { error, message, requestId, details? } for every failure; never a stack trace. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<PoiiRequest>();
    const res = http.getResponse<PoiiResponse>();
    const requestId = req.requestId ?? v7();
    const { status, body } = toErrorBody(exception, requestId);
    if (status >= 500) {
      console.error(JSON.stringify({
        event: 'api.error', requestId, method: req.method, path: (req.originalUrl ?? req.url).split('?')[0],
        error: describeForLog(exception),
      }));
    }
    res.setHeader('x-request-id', requestId);
    res.setHeader('cache-control', 'no-store');
    res.status(status).json(body);
  }
}
