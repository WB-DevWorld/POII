// AccessLobby sign-in, explicit account linking and sign-out (ADR-0004, ADR-0012; AccessLobby consumer contract
// v0.1) as a POII-owned Better Auth plugin, so sessions, the session cookie, the trusted-origin check and the
// rate limiter stay Better Auth's. Endpoints (under /v1/auth):
//   GET  /accesslobby/status              enabled flag; with a session also the link and how this session signed in
//   POST /accesslobby/sign-in             start: { next? } -> { url, binding }
//   POST /accesslobby/link                start "Connect AccessLobby" from a signed-in session -> { url, binding }
//   POST /accesslobby/callback            finish either flow: { state, binding, code | error, iss? }
//   POST /accesslobby/unlink              { password } -> removes the link (local password required, so no lockout)
//   POST /accesslobby/sign-out-all        ends every POII session -> { endSessionUrl } for RP-initiated logout
//   POST /accesslobby/backchannel-logout  { logout_token } from AccessLobby; no cookie, no CSRF header
// An AccessLobby identity that is not linked never signs in and never creates a user (403 NOT_LINKED); a link
// is only ever made from an existing session of the owner, proving both accounts in one flow. No email is read.
import { randomBytes } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx, sessionMiddleware } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import {
  AccessLobbyBackchannelLogoutRequest, AccessLobbyCallbackRequest, AccessLobbySignInRequest, AccessLobbyUnlinkRequest,
} from '@poii/contracts';
import { and, eq, inArray, like, lt, ne } from 'drizzle-orm';
import * as z from 'zod';
import { newId } from '../common/util.js';
import type { Db } from '../db/client.js';
import { accessLobbySession, authSession, authUser, authVerification, identityLink } from '../db/schema/index.js';
import { AccessLobbyClient, AccessLobbyRejected, AccessLobbyUnavailable } from './accesslobby-oidc.identity.js';
import { sameDigest, sha256 } from './identity-secrets.js';

type Log = (event: Record<string, unknown>) => void;

export interface AccessLobbyPluginDeps {
  db: Db;
  client: AccessLobbyClient;
  /** Audit in the owner's workspace; `userId` names the Better Auth user whose actor is attributed (else none). */
  audit: (action: string, details: Record<string, unknown>, userId?: string) => Promise<void>;
  log: Log;
}

/** Better Auth paths this plugin serves over HTTP (added to the adapter's allow-list when AccessLobby is configured). */
export const ACCESSLOBBY_AUTH_PATHS = [
  '/accesslobby/status', '/accesslobby/sign-in', '/accesslobby/link', '/accesslobby/callback', '/accesslobby/unlink',
  '/accesslobby/sign-out-all', '/accesslobby/backchannel-logout',
] as const;

/** A started flow lives this long (Better Auth verification row, consumed once). */
const FLOW_TTL_MS = 10 * 60_000;
/** Seen logout-token jti values are kept longer than a logout token may be old. */
const LOGOUT_JTI_TTL_MS = 15 * 60_000;
const flowKey = (state: string) => `accesslobby-flow:${sha256(state)}`;
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

interface Flow {
  intent: 'signin' | 'link';
  codeVerifier: string;
  nonce: string;
  bindingSha256: string;
  next?: string;
  /** link: the Better Auth user and session that started the flow. */
  userId?: string;
  sessionId?: string;
}

const MESSAGES: Record<string, string> = {
  ACCESSLOBBY_UNAVAILABLE: 'AccessLobby cannot be reached right now. Nothing was changed; try again later.',
  NOT_LINKED: 'This AccessLobby account is not connected to this POII. Sign in with your password and choose "Connect AccessLobby" first.',
  INVALID_FLOW: 'This sign-in attempt is unknown, expired or was started in another browser. Start again.',
  ACCESSLOBBY_DENIED: 'AccessLobby did not complete the sign-in.',
  ISSUER_MISMATCH: 'The answer came from a different AccessLobby issuer.',
  CODE_REJECTED: 'AccessLobby did not accept the sign-in code. Start again.',
  INVALID_ID_TOKEN: 'AccessLobby returned an identity that could not be verified.',
  INVALID_ACCESS_TOKEN: 'AccessLobby returned an access token that could not be verified.',
  ACCESSLOBBY_TOKEN_REJECTED: 'The AccessLobby identity service did not accept the sign-in.',
  PERSON_SUSPENDED: 'This AccessLobby person is suspended.',
  IDENTITY_CONFLICT: 'AccessLobby now reports a different person for this account. The link needs a manual review; nothing was changed.',
  LINK_SESSION_MISMATCH: 'Your POII session ended or changed while connecting AccessLobby. Sign in with your password and connect again.',
  ALREADY_LINKED: 'An AccessLobby account is already connected. Disconnect it first.',
  IDENTITY_ALREADY_LINKED: 'This AccessLobby account is already connected to a POII user.',
  PERSON_ALREADY_LINKED: 'This AccessLobby person is already connected to a POII user.',
  NO_LINK: 'No AccessLobby account is connected.',
  INVALID_LOGOUT_TOKEN: 'Invalid logout token.',
};

const failure = (status: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT' | 'UNAUTHORIZED' | 'SERVICE_UNAVAILABLE', code: string) =>
  APIError.from(status, { code, message: MESSAGES[code] ?? code });

/** `next` after an AccessLobby sign-in: a same-site absolute path only (the web app sanitizes it again). */
function safeNext(next: string | undefined): string | undefined {
  if (!next || next.length > 512 || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return undefined;
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x21 || c === 0x7f) return undefined;
  }
  return next;
}

function constraintOf(error: unknown): string | undefined {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  if (e?.code === '23505') return e.constraint;
  if (e?.cause?.code === '23505') return e.cause.constraint;
  return undefined;
}

export function accessLobbyPlugin(deps: AccessLobbyPluginDeps) {
  const { db, client, audit, log } = deps;
  const issuer = client.settings.issuer;

  /** Turns AccessLobby failures into Better Auth errors with a safe message; the reason goes to the log only. */
  const rethrow = (error: unknown, step: string): never => {
    if (error instanceof AccessLobbyUnavailable) {
      log({ event: 'identity.accesslobby_unavailable', step, reason: error.reason });
      throw failure('SERVICE_UNAVAILABLE', 'ACCESSLOBBY_UNAVAILABLE');
    }
    if (error instanceof AccessLobbyRejected) {
      log({ event: 'identity.accesslobby_rejected', step, code: error.code, reason: error.reason });
      throw failure(error.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', error.code);
    }
    throw error;
  };

  async function startFlow(flow: Omit<Flow, 'codeVerifier' | 'nonce' | 'bindingSha256'>, ctx: { context: { internalAdapter: any } }) {
    const state = random();
    const binding = random();
    const codeVerifier = random(64);
    const nonce = random();
    let url: string;
    try {
      url = await client.authorizationUrl({ state, codeVerifier, nonce, ...(flow.intent === 'link' ? { prompt: 'login' as const } : {}) });
    } catch (error) {
      rethrow(error, 'start');
    }
    await purgeExpired();
    const value: Flow = { ...flow, codeVerifier, nonce, bindingSha256: sha256(binding) };
    await ctx.context.internalAdapter.createVerificationValue({
      identifier: flowKey(state), value: JSON.stringify(value), expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    });
    return { url: url!, binding };
  }

  /** Abandoned flows and old logout-token jti markers are short-lived rows in auth_verification; drop the expired ones. */
  const purgeExpired = () => db.orm.delete(authVerification)
    .where(and(like(authVerification.identifier, 'accesslobby-%'), lt(authVerification.expiresAt, new Date())))
    .catch(error => log({ event: 'identity.accesslobby_purge_failed', message: String(error) }));

  const linkOf = async (userId: string) =>
    (await db.orm.select().from(identityLink).where(eq(identityLink.authUserId, userId)).limit(1))[0];

  return {
    id: 'poii-accesslobby',
    rateLimit: [
      // The unlink check verifies the local password: same budget as sign-in.
      { pathMatcher: (path: string) => path === '/accesslobby/unlink', window: 10, max: 3 },
    ],
    endpoints: {
      accessLobbyStatus: createAuthEndpoint('/accesslobby/status', { method: 'GET' }, async ctx => {
        const session = await getSessionFromCtx(ctx);
        if (!session) return ctx.json({ enabled: true, signedIn: false, link: null, sessionVia: null });
        const link = await linkOf(session.user.id);
        const fromAccessLobby = (await db.orm.select({ id: accessLobbySession.sessionId }).from(accessLobbySession)
          .where(eq(accessLobbySession.sessionId, session.session.id)).limit(1)).length > 0;
        return ctx.json({
          enabled: true,
          signedIn: true,
          link: link ? {
            issuer: link.issuer, personId: link.personId, linkedAt: link.linkedAt.toISOString(),
            lastSignInAt: link.lastSignInAt?.toISOString() ?? null,
          } : null,
          sessionVia: fromAccessLobby ? 'accesslobby' : 'password',
        });
      }),

      accessLobbySignIn: createAuthEndpoint('/accesslobby/sign-in', {
        method: 'POST',
        body: AccessLobbySignInRequest,
      }, async ctx => {
        const next = safeNext(ctx.body.next);
        return ctx.json(await startFlow({ intent: 'signin', ...(next ? { next } : {}) }, ctx));
      }),

      accessLobbyLink: createAuthEndpoint('/accesslobby/link', {
        method: 'POST',
        body: z.object({}).optional(),
        use: [sessionMiddleware],
      }, async ctx => {
        const { session, user } = ctx.context.session;
        if (await linkOf(user.id)) throw failure('CONFLICT', 'ALREADY_LINKED');
        return ctx.json(await startFlow({ intent: 'link', userId: user.id, sessionId: session.id }, ctx));
      }),

      accessLobbyCallback: createAuthEndpoint('/accesslobby/callback', {
        method: 'POST',
        body: AccessLobbyCallbackRequest,
      }, async ctx => {
        const { state, binding, code, iss, error } = ctx.body;
        // Single use: a replayed or concurrent callback for the same state finds nothing.
        const row = await ctx.context.internalAdapter.consumeVerificationValue(flowKey(state));
        let flow: Flow | undefined;
        try {
          flow = row ? JSON.parse(row.value) as Flow : undefined;
        } catch {
          flow = undefined;
        }
        // The binding secret travels in the browser's own short-lived cookie: the flow belongs to this browser.
        if (!flow || !sameDigest(flow.bindingSha256, sha256(binding))) throw failure('BAD_REQUEST', 'INVALID_FLOW');
        if (error) {
          log({ event: 'identity.accesslobby_rejected', step: 'authorize', code: 'ACCESSLOBBY_DENIED', reason: error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) });
          throw failure('BAD_REQUEST', 'ACCESSLOBBY_DENIED');
        }
        if (!code) throw failure('BAD_REQUEST', 'INVALID_FLOW');
        // RFC 9207: when AccessLobby names its issuer on the redirect, it must be ours (mix-up defence).
        if (iss !== undefined && iss !== issuer) throw failure('BAD_REQUEST', 'ISSUER_MISMATCH');

        let sub: string, sid: string | undefined, personId: string, idToken: string;
        try {
          const tokens = await client.exchangeCode(code, flow.codeVerifier);
          const verified = await client.verifyIdToken(tokens.idToken, flow.nonce);
          await client.verifyAccessToken(tokens.accessToken, verified.sub);
          // Contract: complete only after `/v1/me` resolved the durable person ID; a failure fails closed.
          personId = (await client.resolvePerson(tokens.accessToken)).id;
          ({ sub, sid } = verified);
          idToken = tokens.idToken;
        } catch (caught) {
          return rethrow(caught, 'callback');
        }

        if (flow.intent === 'link') {
          // Proof of the POII account: the session that started the flow must still be valid in this browser.
          const current = await getSessionFromCtx(ctx);
          if (!current || current.session.id !== flow.sessionId || current.user.id !== flow.userId) {
            await audit('identity.accesslobby_link_refused', { issuer, reason: 'session_mismatch' });
            throw failure('UNAUTHORIZED', 'LINK_SESSION_MISMATCH');
          }
          const userId = current.user.id;
          const refuse = async (codeName: string) => {
            await audit('identity.accesslobby_link_refused', { issuer, reason: codeName.toLowerCase() }, userId);
            return failure('CONFLICT', codeName);
          };
          const bySubject = (await db.orm.select().from(identityLink)
            .where(and(eq(identityLink.issuer, issuer), eq(identityLink.subject, sub))).limit(1))[0];
          if (bySubject) throw await refuse(bySubject.authUserId === userId ? 'ALREADY_LINKED' : 'IDENTITY_ALREADY_LINKED');
          if ((await db.orm.select({ id: identityLink.id }).from(identityLink).where(eq(identityLink.personId, personId)).limit(1)).length) {
            throw await refuse('PERSON_ALREADY_LINKED');
          }
          if (await linkOf(userId)) throw await refuse('ALREADY_LINKED');
          const actorId = (await db.orm.select({ actorId: authUser.actorId }).from(authUser).where(eq(authUser.id, userId)).limit(1))[0]?.actorId ?? null;
          try {
            await db.orm.insert(identityLink).values({ id: newId(), issuer, subject: sub, personId, authUserId: userId, actorId });
          } catch (caught) {
            // A concurrent link won the race; the unique indexes decide.
            const constraint = constraintOf(caught);
            if (constraint === 'identity_link_person_unique') throw await refuse('PERSON_ALREADY_LINKED');
            if (constraint === 'identity_link_issuer_subject_unique') throw await refuse('IDENTITY_ALREADY_LINKED');
            if (constraint === 'identity_link_user_unique') throw await refuse('ALREADY_LINKED');
            throw caught;
          }
          await audit('identity.accesslobby_linked', { issuer, personId }, userId);
          log({ event: 'identity.accesslobby_linked' });
          return ctx.json({ intent: 'link' as const });
        }

        // Sign-in: only an explicitly linked identity; never a new user, never a match by email.
        const link = (await db.orm.select().from(identityLink)
          .where(and(eq(identityLink.issuer, issuer), eq(identityLink.subject, sub))).limit(1))[0];
        if (!link) {
          await audit('identity.accesslobby_signin_refused', { issuer, reason: 'not_linked' });
          throw failure('FORBIDDEN', 'NOT_LINKED');
        }
        if (link.personId !== personId) {
          await audit('identity.accesslobby_signin_refused', { issuer, reason: 'identity_conflict' }, link.authUserId);
          throw failure('CONFLICT', 'IDENTITY_CONFLICT');
        }
        const user = await ctx.context.internalAdapter.findUserById(link.authUserId);
        if (!user) throw failure('FORBIDDEN', 'NOT_LINKED');
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await db.orm.insert(accessLobbySession).values({ sessionId: session.id, issuer, subject: sub, sid: sid ?? null, idToken });
        const actorId = (await db.orm.select({ actorId: authUser.actorId }).from(authUser).where(eq(authUser.id, user.id)).limit(1))[0]?.actorId ?? null;
        await db.orm.update(identityLink).set({ lastSignInAt: new Date(), actorId }).where(eq(identityLink.id, link.id));
        await setSessionCookie(ctx, { session, user });
        await audit('auth.signed_in', { method: 'accesslobby' }, user.id);
        return ctx.json({ intent: 'signin' as const, next: flow.next ?? '/' });
      }),

      accessLobbyUnlink: createAuthEndpoint('/accesslobby/unlink', {
        method: 'POST',
        body: AccessLobbyUnlinkRequest,
        use: [sessionMiddleware],
      }, async ctx => {
        const { session, user } = ctx.context.session;
        // Deliberate: the local password, so the owner can never be left with neither way in.
        await ctx.context.password.checkPassword(user.id, ctx);
        const removed = await db.orm.delete(identityLink).where(eq(identityLink.authUserId, user.id)).returning();
        if (!removed.length) throw failure('CONFLICT', 'NO_LINK');
        // AccessLobby is no longer a way in: end the other sessions that came from it.
        const others = await db.orm.select({ id: accessLobbySession.sessionId }).from(accessLobbySession)
          .innerJoin(authSession, eq(authSession.id, accessLobbySession.sessionId))
          .where(and(eq(authSession.userId, user.id), ne(authSession.id, session.id)));
        if (others.length) await db.orm.delete(authSession).where(inArray(authSession.id, others.map(o => o.id)));
        await audit('identity.accesslobby_unlinked', { issuer: removed[0]!.issuer, personId: removed[0]!.personId, endedSessions: others.length }, user.id);
        return ctx.json({ unlinked: true });
      }),

      accessLobbySignOutAll: createAuthEndpoint('/accesslobby/sign-out-all', {
        method: 'POST',
        body: z.object({}).optional(),
        use: [sessionMiddleware],
      }, async ctx => {
        const { session, user } = ctx.context.session;
        const idToken = (await db.orm.select({ idToken: accessLobbySession.idToken }).from(accessLobbySession)
          .where(eq(accessLobbySession.sessionId, session.id)).limit(1))[0]?.idToken;
        // POII first, so this never depends on AccessLobby being reachable.
        await ctx.context.internalAdapter.deleteUserSessions(user.id);
        deleteSessionCookie(ctx);
        let endSessionUrl: string | null = null;
        try {
          endSessionUrl = await client.endSessionUrl(idToken);
        } catch (error) {
          log({ event: 'identity.accesslobby_unavailable', step: 'end_session', reason: error instanceof AccessLobbyUnavailable ? error.reason : String(error) });
        }
        await audit('auth.signed_out_all_apps', { accesslobbyReachable: endSessionUrl !== null }, user.id);
        return ctx.json({ endSessionUrl });
      }),

      accessLobbyBackchannelLogout: createAuthEndpoint('/accesslobby/backchannel-logout', {
        method: 'POST',
        body: AccessLobbyBackchannelLogoutRequest.passthrough(),
        metadata: { allowedMediaTypes: ['application/x-www-form-urlencoded', 'application/json'] },
      }, async ctx => {
        ctx.setHeader('cache-control', 'no-store');
        let token;
        try {
          token = await client.verifyLogoutToken(ctx.body.logout_token);
        } catch (error) {
          // OpenID Connect Back-Channel Logout 1.0: 400 for an invalid token; the reason stays in the log.
          log({ event: 'identity.accesslobby_logout_token_refused', reason: error instanceof AccessLobbyRejected || error instanceof AccessLobbyUnavailable ? error.reason : String(error) });
          throw failure('BAD_REQUEST', 'INVALID_LOGOUT_TOKEN');
        }
        // Replay protection: each jti is accepted once (atomic first-writer-wins row).
        await purgeExpired();
        const fresh = await ctx.context.internalAdapter.reserveVerificationValue({
          identifier: `accesslobby-logout-jti:${sha256(`${issuer}\n${token.jti}`)}`, value: '1', expiresAt: new Date(Date.now() + LOGOUT_JTI_TTL_MS),
        });
        if (!fresh) {
          log({ event: 'identity.accesslobby_logout_token_refused', reason: 'replayed jti' });
          throw failure('BAD_REQUEST', 'INVALID_LOGOUT_TOKEN');
        }
        let userId: string | undefined;
        if (token.sub) {
          userId = (await db.orm.select({ userId: identityLink.authUserId }).from(identityLink)
            .where(and(eq(identityLink.issuer, issuer), eq(identityLink.subject, token.sub))).limit(1))[0]?.userId;
        } else if (token.sid) {
          userId = (await db.orm.select({ userId: authSession.userId }).from(accessLobbySession)
            .innerJoin(authSession, eq(authSession.id, accessLobbySession.sessionId))
            .where(and(eq(accessLobbySession.issuer, issuer), eq(accessLobbySession.sid, token.sid))).limit(1))[0]?.userId;
        }
        // Unknown subjects get the same 200 as known ones: the answer never says which subjects exist.
        if (userId) {
          // Every POII session of the linked user ends (ADR-0012: owner-only, a password session is not tied to a sid).
          const ended = await db.orm.delete(authSession).where(eq(authSession.userId, userId)).returning({ id: authSession.id });
          await audit('identity.accesslobby_backchannel_logout', { issuer, endedSessions: ended.length, bySid: !token.sub }, userId);
        }
        return ctx.json({});
      }),
    },
  } satisfies BetterAuthPlugin;
}
