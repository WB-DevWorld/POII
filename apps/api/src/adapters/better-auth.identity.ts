// `local-signin` identity adapter (ADR-0004, ADR-0009): password sign-in for standalone deployments, backed by
// Better Auth. Better Auth owns password hashing (its scrypt), sessions (auth_session in PostgreSQL), sign-in,
// sign-out, session revocation, password change and rate limiting; its own endpoints are mounted under /v1/auth
// (httpHandlers). POII keeps: mapping the Better Auth user to the owner actor, owner-only mode, the first-run
// bootstrap from POII_OWNER_BOOTSTRAP_PASSWORD, and the CSRF header check on POII's own /v1 mutations.
// #17: with POII_ACCESSLOBBY_ISSUER set, the AccessLobby plugin (accesslobby-oidc.auth-plugin.ts) adds AccessLobby
// sign-in, explicit linking and back-channel logout to the same handler (ADR-0012).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { toNodeHandler } from 'better-auth/node';
import { username } from 'better-auth/plugins/username';
import { and, eq } from 'drizzle-orm';
import type { Settings } from '../config.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../config.js';
import { AppError } from '../common/errors.js';
import { newId } from '../common/util.js';
import type { Db } from '../db/client.js';
import { actor, auditEvent, authUser, betterAuthSchema, workspace } from '../db/schema/index.js';
import type { ActorRow, WorkspaceRow } from '../db/types.js';
import type { IdentityPort, IdentityRequest, ResolvedIdentity } from '../ports/identity.js';
import { assertNotCrossSite, clientAddress, header, originOf } from './identity-secrets.js';
import { bootstrapOwnerWorkspace, isLoopbackUrl } from './local-owner.identity.js';
// #17 AccessLobby OIDC
import { ACCESSLOBBY_AUTH_PATHS, accessLobbyPlugin } from './accesslobby-oidc.auth-plugin.js';
import { AccessLobbyClient } from './accesslobby-oidc.identity.js';

type SignInSettings = Pick<Settings, 'ownerDisplayName' | 'webBaseUrl' | 'auth'> & Partial<Pick<Settings, 'accesslobby'>>; // #17
type Owner = { actor: ActorRow; workspace: WorkspaceRow };
type Log = (event: Record<string, unknown>) => void;
type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/** Where Better Auth's endpoints are mounted on the API. */
export const AUTH_BASE_PATH = '/v1/auth';
/** Better Auth requires an email; the owner gets this reserved (RFC 2606), never-used address. No email is ever sent. */
export const SYNTHETIC_OWNER_EMAIL = 'owner@poii.invalid';
/** Cookie prefix: the session cookie is `poii.session_token` (`__Secure-poii.session_token` with Secure cookies). */
export const AUTH_COOKIE_PREFIX = 'poii';
/**
 * The only header Better Auth reads the client address from (rate limiting, session metadata). The mount
 * middleware always overwrites it: the socket address, or the trusted proxy's X-Forwarded-For entry.
 */
export const CLIENT_IP_HEADER = 'x-poii-client-ip';
/** Better Auth endpoints reachable over HTTP. Everything else it ships answers 404; sign-up answers 403. */
export const HTTP_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/username', '/sign-out', '/get-session', '/list-sessions', '/revoke-session', '/revoke-sessions',
  '/revoke-other-sessions', '/change-password', '/ok',
]);

const unauthenticated = (message = 'Sign in first') => new AppError(401, 'unauthenticated', message);

export interface BetterAuthIdentityOptions {
  log?: Log;
}

function createAuth(db: Db, settings: SignInSettings, hooks: {
  ownerActorId: () => Promise<string>;
  hasUser: () => Promise<boolean>;
  audit: (userId: string, action: string, details?: Record<string, unknown>) => Promise<void>;
  /** #17: audit in the owner's workspace, attributed to the user's actor when given. */
  auditOwner: (action: string, details: Record<string, unknown>, userId?: string) => Promise<void>;
  log: Log;
}) {
  const webOrigin = originOf(settings.webBaseUrl);
  // #17 AccessLobby OIDC: its plugin and HTTP paths only when POII_ACCESSLOBBY_ISSUER is configured.
  const accessLobby = settings.accesslobby
    ? accessLobbyPlugin({ db, client: new AccessLobbyClient(settings.accesslobby), audit: hooks.auditOwner, log: hooks.log })
    : undefined;
  const httpPaths: ReadonlySet<string> = accessLobby ? new Set([...HTTP_AUTH_PATHS, ...ACCESSLOBBY_AUTH_PATHS]) : HTTP_AUTH_PATHS;
  return betterAuth({
    appName: 'POII',
    baseURL: settings.auth.apiBaseUrl,
    basePath: AUTH_BASE_PATH,
    secret: settings.auth.sessionSecret,
    database: drizzleAdapter(db.orm, { provider: 'pg', schema: betterAuthSchema }),
    trustedOrigins: webOrigin ? [webOrigin] : [],
    telemetry: { enabled: false },
    logger: {
      // 'info' routes Better Auth's own error lines through this logger too (its router prints warn/error/debug levels itself).
      level: 'info',
      log: (level, message) => hooks.log({ event: 'better_auth', level, message }),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      requireEmailVerification: false,
      // Bootstrap creates the owner server-side; it must not leave a session behind.
      autoSignIn: false,
    },
    user: {
      modelName: 'auth_user',
      additionalFields: {
        // The POII actor this user signs in as. Never accepted from a request body.
        actorId: { type: 'string', required: false, input: false },
      },
    },
    session: {
      modelName: 'auth_session',
      expiresIn: Math.max(1, Math.round(settings.auth.sessionTtlHours * 3600)),
      // Absolute lifetime: a session is never extended by use.
      disableSessionRefresh: true,
      // Every request reads the session row, so sign-out and revocation take effect immediately.
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_account',
      // ND-2: no account linking, in particular none by email.
      accountLinking: { enabled: false },
    },
    verification: { modelName: 'auth_verification' },
    // Better Auth turns rate limiting off outside NODE_ENV=production; POII always wants it.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      useSecureCookies: !isLoopbackUrl(settings.webBaseUrl),
      cookiePrefix: AUTH_COOKIE_PREFIX,
      // Explicit: Better Auth would skip its Origin check when NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: accessLobby ? [username(), accessLobby] : [username()],
    hooks: {
      before: createAuthMiddleware(async ctx => {
        // Server-side auth.api calls (the bootstrap) carry no request and are trusted.
        if (!ctx.request) return;
        if (ctx.request.headers.get('authorization') !== null) {
          throw APIError.from('FORBIDDEN', { code: 'TOKEN_NOT_ALLOWED', message: 'Tokens cannot sign in or manage sessions' });
        }
        if (ctx.path.startsWith('/sign-up')) {
          throw APIError.from('FORBIDDEN', { code: 'SIGN_UP_DISABLED', message: 'This install has a single owner; sign-up is not available' });
        }
        if (!httpPaths.has(ctx.path)) throw APIError.from('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' });
        if (ctx.path === '/sign-in/username' && !(await hooks.hasUser())) {
          throw APIError.from('CONFLICT', {
            code: 'SIGNIN_NOT_CONFIGURED', message: 'No password is set up yet: set POII_OWNER_BOOTSTRAP_PASSWORD and restart the API',
          });
        }
      }),
      after: createAuthMiddleware(async ctx => {
        if (!ctx.request || isAPIError(ctx.context.returned)) return;
        const action = AUDITED[ctx.path];
        const userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id;
        if (!action || !userId) return;
        await hooks.audit(userId, action).catch(error => hooks.log({ event: 'identity.audit_failed', action, message: String(error) }));
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Owner-only mode: exactly one Better Auth user, attached to the owner actor. The unique index
          // auth_user_single_owner enforces the same in the database.
          before: async user => {
            // CONFLICT, not FORBIDDEN: Better Auth turns a 403 here into a silent generic sign-up response.
            if (await hooks.hasUser()) {
              throw APIError.from('CONFLICT', { code: 'OWNER_ONLY', message: 'This install has exactly one sign-in user, the owner' });
            }
            return { data: { ...user, actorId: await hooks.ownerActorId() } };
          },
        },
      },
    },
  });
}

/** Audited Better Auth actions (sign-out is not: Better Auth does not hand the ended session to the after hook). */
const AUDITED: Record<string, string> = {
  '/sign-in/username': 'auth.signed_in',
  '/revoke-sessions': 'auth.signed_out_all',
  '/change-password': 'auth.password_changed',
};

export type BetterAuthInstance = ReturnType<typeof createAuth>;

export class BetterAuthIdentity implements IdentityPort {
  readonly name = 'local-signin';
  readonly requiresSignIn = true;
  readonly auth: BetterAuthInstance;
  private readonly trustedOrigins: string[];
  private readonly log: Log;
  private ready: Promise<Owner> | undefined;

  constructor(private readonly db: Db, private readonly settings: SignInSettings, options: BetterAuthIdentityOptions = {}) {
    if (!settings.auth.sessionSecret) throw new Error('POII_SESSION_SECRET is required for local-signin');
    this.trustedOrigins = [originOf(settings.webBaseUrl)].filter((o): o is string => !!o);
    this.log = options.log ?? (event => console.info(JSON.stringify(event)));
    this.auth = createAuth(db, settings, {
      ownerActorId: async () => (await this.owner()).actor.id,
      hasUser: () => this.hasUser(),
      audit: (userId, action) => this.auditUser(userId, action),
      auditOwner: (action, details, userId) => this.auditOwner(action, details, userId), // #17
      log: this.log,
    });
  }

  invalidate(): void {
    this.ready = undefined;
  }

  /** Workspace, owner and (while no sign-in user exists) the bootstrapped owner user. Cached until invalidate(). */
  ensureReady(): Promise<Owner> {
    this.ready ??= this.bootstrap().catch(error => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async resolve(request: IdentityRequest): Promise<ResolvedIdentity> {
    await this.ensureReady();
    const cookie = header(request, 'cookie');
    if (!cookie) throw unauthenticated();
    // Only the cookie is handed to Better Auth: it reads the session row on every call (cookie cache off).
    const found = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!found) throw unauthenticated();
    assertNotCrossSite(request, this.trustedOrigins);
    const owner = await this.actorOf(found.user.id, found.user.actorId ?? null);
    return { ...owner, via: 'session' };
  }

  /**
   * Express middleware for `/v1/auth`, mounted before any body parser so Better Auth reads the raw body:
   * sets the client address header, waits for the bootstrap, then hands the request to Better Auth.
   */
  httpHandlers(): NodeMiddleware[] {
    const handler = toNodeHandler(this.auth);
    const trustProxy = this.settings.auth.trustProxy;
    return [
      (req, _res, next) => {
        const address = clientAddress(req.headers, req.socket.remoteAddress, trustProxy);
        delete req.headers[CLIENT_IP_HEADER];
        if (address) req.headers[CLIENT_IP_HEADER] = address;
        this.ensureReady().then(() => next(), next);
      },
      (req, res, next) => {
        handler(req, res).catch(next);
      },
    ];
  }

  private async hasUser(): Promise<boolean> {
    return (await this.db.orm.select({ id: authUser.id }).from(authUser).limit(1)).length > 0;
  }

  private owner(): Promise<Owner> {
    return bootstrapOwnerWorkspace(this.db, this.settings.ownerDisplayName, this.name);
  }

  /** The person actor a Better Auth user signs in as; re-attached to the current owner when it no longer exists (after a restore). */
  private async actorOf(userId: string, actorId: string | null): Promise<Owner> {
    const row = actorId ? await this.person(actorId) : undefined;
    if (!row) return this.reattach(userId);
    if (row.actor.revokedAt) throw unauthenticated('This person has been revoked');
    return row;
  }

  private async person(actorId: string): Promise<Owner | undefined> {
    return (await this.db.orm.select({ actor, workspace }).from(actor)
      .innerJoin(workspace, eq(workspace.id, actor.workspaceId))
      .where(and(eq(actor.id, actorId), eq(actor.kind, 'person'))).limit(1))[0];
  }

  private async reattach(userId: string): Promise<Owner> {
    const owner = await this.owner();
    await this.db.orm.transaction(async tx => {
      await tx.update(authUser).set({ actorId: owner.actor.id }).where(eq(authUser.id, userId));
      await tx.insert(auditEvent).values({
        id: newId(), workspaceId: owner.workspace.id, actorId: owner.actor.id, action: 'identity.credential_reattached',
        targetType: 'actor', targetId: owner.actor.id, details: {},
      });
    });
    this.log({ event: 'identity.credential_reattached' });
    return owner;
  }

  private async bootstrap(): Promise<Owner> {
    const owner = await this.owner();
    const user = (await this.db.orm.select({ id: authUser.id, actorId: authUser.actorId }).from(authUser).limit(1))[0];
    const password = this.settings.auth.bootstrapPassword;
    if (user) {
      if (password) {
        this.log({ event: 'identity.bootstrap_password_ignored', message: 'A sign-in user already exists; remove POII_OWNER_BOOTSTRAP_PASSWORD' });
      }
      // A restore removed the actor the user was attached to: re-attach it to the current owner now.
      if (!user.actorId || !(await this.person(user.actorId))) await this.reattach(user.id);
      return owner;
    }
    if (!password) {
      this.log({ event: 'identity.signin_not_configured', message: 'Set POII_OWNER_BOOTSTRAP_PASSWORD to create the owner password' });
      return owner;
    }
    try {
      // Server-side call: no HTTP request, so the sign-up refusal hook lets it through. Better Auth hashes the password.
      await this.auth.api.signUpEmail({
        body: { name: this.settings.ownerDisplayName, email: SYNTHETIC_OWNER_EMAIL, password, username: this.settings.auth.ownerLogin },
      });
    } catch (error) {
      // Another API process may have created the owner first (auth_user_single_owner); anything else is fatal.
      if (await this.hasUser()) return owner;
      throw error;
    }
    if (!(await this.hasUser())) throw new Error('Better Auth did not create the owner user');
    await this.db.orm.insert(auditEvent).values({
      id: newId(), workspaceId: owner.workspace.id, actorId: owner.actor.id, action: 'identity.owner_password_bootstrapped',
      targetType: 'actor', targetId: owner.actor.id, details: { login: this.settings.auth.ownerLogin.toLowerCase() },
    });
    this.log({ event: 'identity.owner_password_bootstrapped', login: this.settings.auth.ownerLogin.toLowerCase() });
    return owner;
  }

  /** #17: an audit event in the owner's workspace, attributed to the user's actor when one is given and still exists. */
  private async auditOwner(action: string, details: Record<string, unknown>, userId?: string): Promise<void> {
    try {
      const owner = await this.ensureReady();
      const row = userId
        ? (await this.db.orm.select({ actor }).from(authUser).innerJoin(actor, eq(actor.id, authUser.actorId)).where(eq(authUser.id, userId)).limit(1))[0]
        : undefined;
      await this.db.orm.insert(auditEvent).values({
        id: newId(), workspaceId: row?.actor.workspaceId ?? owner.workspace.id, actorId: row?.actor.id ?? null, action,
        targetType: 'actor', targetId: row?.actor.id ?? owner.actor.id, details,
      });
    } catch (error) {
      this.log({ event: 'identity.audit_failed', action, message: String(error) });
    }
  }

  private async auditUser(userId: string, action: string): Promise<void> {
    const row = (await this.db.orm.select({ actor }).from(authUser)
      .innerJoin(actor, eq(actor.id, authUser.actorId)).where(eq(authUser.id, userId)).limit(1))[0];
    if (!row) return;
    await this.db.orm.insert(auditEvent).values({
      id: newId(), workspaceId: row.actor.workspaceId, actorId: row.actor.id, action, targetType: 'actor', targetId: row.actor.id, details: {},
    });
  }
}
