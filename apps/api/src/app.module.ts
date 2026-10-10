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
    identity: new LocalOwnerIdentity(db, settings),
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
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(requestIdMiddleware).forRoutes({ path: '/{*path}', method: RequestMethod.ALL });
    }
  }
  return { module: AppModule, db, ports, shutdown: () => db.close() };
}

/** HTTP-level settings that must be applied before the app initializes (call before listen/init). */
export function configureHttpApp(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
