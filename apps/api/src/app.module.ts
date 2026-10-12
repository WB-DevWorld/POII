import { Module, RequestMethod, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Settings } from './config.js';
import { createDb, type Db } from './db/client.js';
import { HealthController } from './health.controller.js';
import { LocalFsStorage } from './adapters/local-fs.storage.js';
import { LocalOwnerIdentity } from './adapters/local-owner.identity.js';
import { OffAiExecution } from './adapters/off.ai-execution.js';
import { ContextInterceptor } from './common/context.interceptor.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import { requestIdMiddleware } from './common/request-id.middleware.js';
import { AI_EXECUTION_PORT, DB, IDENTITY_PORT, SETTINGS, STORAGE_PORT } from './common/tokens.js';
import { BackupController } from './modules/backup/backup.controller.js';
import { BackupService } from './modules/backup/backup.service.js';
import { ExportsController } from './modules/exports/exports.controller.js';
import { ExportsService } from './modules/exports/exports.service.js';
import { AgentInstructionsController } from './modules/exports/agent-instructions.controller.js'; // #19
import { AgentInstructionsService } from './modules/exports/agent-instructions.service.js'; // #19
import { IdentityController } from './modules/identity/identity.controller.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { RecordsController } from './modules/records/records.controller.js';
import { RecordsService } from './modules/records/records.service.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchService } from './modules/search/search.service.js';
import { SourcesController } from './modules/sources/sources.controller.js';
import { SourcesService } from './modules/sources/sources.service.js';
import { ViewsController } from './modules/views/views.controller.js';
import { ViewsService } from './modules/views/views.service.js';
import type { AiExecutionPort } from './ports/ai-execution.js';
import type { IdentityPort } from './ports/identity.js';
import type { StoragePort } from './ports/storage.js';
// #13 AI
import { createAiExecution } from './ai/factory.js';
import { AiController } from './modules/ai/ai.controller.js';
import { AiService } from './modules/ai/ai.service.js';
// end #13 AI
// #14 auth and tokens
import { AUTH_BASE_PATH, BetterAuthIdentity } from './adapters/better-auth.identity.js';
import { OwnerTokenIdentity } from './adapters/owner-token.identity.js';
import { TokensController } from './modules/tokens/tokens.controller.js';
import { TokensService } from './modules/tokens/tokens.service.js';

/** The configured identity adapter, with owner tokens (Authorization: Bearer) resolved in front of it. */
export function identityFor(settings: Settings, db: Db): IdentityPort {
  const inner = settings.identityAdapter === 'local-signin' ? new BetterAuthIdentity(db, settings) : new LocalOwnerIdentity(db, settings);
  return new OwnerTokenIdentity(db, inner);
}

/** Better Auth behind the identity port, when local-signin is configured. */
export function signInAdapter(ports: Ports): BetterAuthIdentity | undefined {
  const identity = ports.identity;
  const inner = identity instanceof OwnerTokenIdentity ? identity.inner : identity;
  return inner instanceof BetterAuthIdentity ? inner : undefined;
}
const AUTH_CONTROLLERS = [TokensController];
const AUTH_PROVIDERS = [TokensService];
// end #14 auth and tokens

export { DB, SETTINGS };

/** Largest accepted JSON body: a 20 MB source plus envelope, or a restore document with base64 originals. */
export const JSON_BODY_LIMIT = '100mb';

export interface Ports {
  identity: IdentityPort;
  storage: StoragePort;
  ai: AiExecutionPort;
}

export function createPorts(settings: Settings, db: Db): Ports {
  return {
    identity: identityFor(settings, db), // #14 auth and tokens
    storage: new LocalFsStorage(settings.storageLocalDir),
    ai: settings.aiEnabled ? createAiExecution(settings, db) : new OffAiExecution(), // #13 AI
  };
}

export function createApp(settings: Settings, db: Db = createDb(settings.databaseUrl), ports: Ports = createPorts(settings, db)) {
  @Module({
    controllers: [
      HealthController, IdentityController, SourcesController, RecordsController, ViewsController, SearchController,
      ExportsController, BackupController,
      AiController, // #13 AI
      AgentInstructionsController, // #19
      ...AUTH_CONTROLLERS, // #14 auth and tokens
    ],
    providers: [
      { provide: SETTINGS, useValue: settings },
      { provide: DB, useValue: db },
      { provide: IDENTITY_PORT, useValue: ports.identity },
      { provide: STORAGE_PORT, useValue: ports.storage },
      { provide: AI_EXECUTION_PORT, useValue: ports.ai },
      { provide: APP_FILTER, useClass: ApiExceptionFilter },
      { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
      IdentityService, SourcesService, RecordsService, ViewsService, SearchService, ExportsService, BackupService,
      AiService, // #13 AI
      AgentInstructionsService, // #19
      ...AUTH_PROVIDERS, // #14 auth and tokens
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(requestIdMiddleware).forRoutes({ path: '/{*path}', method: RequestMethod.ALL });
    }
  }
  return { module: AppModule, db, ports, shutdown: () => db.close() };
}

/**
 * HTTP-level setup that must run before the app initializes (call before listen/init), on an app created with
 * `{ bodyParser: false }`. Order matters: Better Auth's handler (local-signin) is mounted at /v1/auth first so it
 * reads the raw request body itself; Nest's JSON and urlencoded parsers come after it.
 */
export function configureHttpApp(app: INestApplication, ports: Ports): void {
  const http = app as NestExpressApplication;
  // #14 auth and tokens
  const signin = signInAdapter(ports);
  if (signin) http.use(AUTH_BASE_PATH, ...signin.httpHandlers());
  http.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  http.useBodyParser('urlencoded', { extended: true });
}
