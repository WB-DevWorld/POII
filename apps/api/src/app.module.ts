import { Module } from '@nestjs/common';
import type { Settings } from './config.js';
import { createDb, type Db } from './db/client.js';
import { HealthController } from './health.controller.js';

export const SETTINGS = 'SETTINGS';
export const DB = 'DB';

export function createApp(settings: Settings, db: Db = createDb(settings.databaseUrl)) {
  @Module({
    controllers: [HealthController],
    providers: [
      { provide: SETTINGS, useValue: settings },
      { provide: DB, useValue: db },
    ],
  })
  class AppModule {}
  return { module: AppModule, db, shutdown: () => db.close() };
}
