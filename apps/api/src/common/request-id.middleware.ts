import { v7 } from 'uuid';
import type { PoiiRequest, PoiiResponse } from './request-context.js';

const ACCEPTABLE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Echoes a sane incoming x-request-id or issues a UUID; every /v1 response is cache-control: no-store. */
export function requestIdMiddleware(req: PoiiRequest, res: PoiiResponse, next: () => void): void {
  const incoming = req.headers['x-request-id'];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  req.requestId = value && ACCEPTABLE.test(value) ? value : v7();
  res.setHeader('x-request-id', req.requestId);
  const url = req.originalUrl ?? req.url;
  if (url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?')) res.setHeader('cache-control', 'no-store');
  next();
}
