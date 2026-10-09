import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config } from './config.js';
import { createApp } from './app.module.js';

const settings = config();
const { module: AppModule, shutdown } = createApp(settings);
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
app.enableShutdownHooks();
await app.listen(settings.port, '0.0.0.0');
console.info(JSON.stringify({ event: 'api.started', port: settings.port, version: settings.version, aiEnabled: settings.aiEnabled }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { await app.close(); await shutdown(); process.exit(0); });
}
