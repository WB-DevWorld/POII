// Request primitives for the identity adapters (ADR-0009): owner-token secrets (random, SHA-256 at rest,
// constant-time comparison), bearer parsing, the CSRF check for POII's own cookie-authenticated mutations and
// the client address handed to Better Auth's rate limiter. Password hashing and sessions belong to Better
// Auth (better-auth.identity.ts); nothing here hashes passwords or issues sessions. No secret is ever logged.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/errors.js';
import type { IdentityRequest } from '../ports/identity.js';

// ----- owner-token secrets -------------------------------------------------------------------------

export const TOKEN_PREFIX = 'poii_';
const TOKEN_PATTERN = /^poii_[A-Za-z0-9_-]{43}$/;

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Constant-time comparison of two hex digests of equal length. */
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** An owner-token secret: `poii_` + 32 random bytes, base64url. */
export const newTokenSecret = (): string => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const isTokenSecret = (value: string): boolean => TOKEN_PATTERN.test(value);

// ----- request parsing -----------------------------------------------------------------------------

export const CSRF_HEADER = 'x-poii-csrf';

export function header(request: IdentityRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** `Authorization: Bearer <secret>` → secret; any other Authorization header → 401. */
export function bearerSecret(request: IdentityRequest): string | undefined {
  const value = header(request, 'authorization');
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  if (!match) throw new AppError(401, 'invalid_token', 'Authorization must be "Bearer <token>"');
  return match[1]!;
}

// ----- CSRF ----------------------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF check for POII's own cookie-authenticated mutations (everything under /v1 except Better Auth's
 * /v1/auth/*, which has its own Origin check). Three layers, any one failing rejects: Sec-Fetch-Site must not
 * say cross-site or same-site; an Origin, when present, must be the web app's; and the custom header
 * `x-poii-csrf: 1` must be present. HTML forms cannot set custom headers and the API answers no CORS
 * preflight, so a forged cross-site form or fetch never carries it. Bearer-token requests carry no ambient
 * credential and are exempt.
 */
export function assertNotCrossSite(request: IdentityRequest, trustedOrigins: readonly string[]): void {
  const method = (request.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  const site = header(request, 'sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new AppError(403, 'csrf_rejected', 'Cross-site requests cannot change anything');
  }
  const origin = header(request, 'origin');
  if (origin !== undefined && !trustedOrigins.includes(origin)) {
    throw new AppError(403, 'csrf_rejected', 'The request came from an untrusted origin');
  }
  if (header(request, CSRF_HEADER) !== '1') {
    throw new AppError(403, 'csrf_rejected', `Cookie-authenticated changes need the ${CSRF_HEADER}: 1 header`);
  }
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// ----- client address ------------------------------------------------------------------------------

/**
 * The address a request comes from, for Better Auth's rate limiter: the socket address, or, only when the
 * API sits behind a trusted proxy (POII_TRUST_PROXY=true, e.g. the web app), the right-most
 * X-Forwarded-For entry that proxy appended. Undefined when neither is known.
 */
export function clientAddress(headers: IdentityRequest['headers'], socketAddress: string | undefined, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const raw = headers['x-forwarded-for'];
    const forwarded = Array.isArray(raw) ? raw.join(',') : raw;
    const last = forwarded?.split(',').map(p => p.trim()).filter(Boolean).pop();
    if (last && last.length <= 64) return last;
  }
  return socketAddress;
}
