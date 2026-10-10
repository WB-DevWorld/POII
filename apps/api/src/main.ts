import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config } from './config.js';
import { configureHttpApp, createApp, signInAdapter } from './app.module.js';

const settings = config();
const { module: AppModule, ports, shutdown } = createApp(settings);
// Body parsers are registered by configureHttpApp, after Better Auth's handler (local-signin).
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
configureHttpApp(app, ports);
// local-signin: bootstrap the owner (or log why sign-in is not configured) at start, not on the first request.
await signInAdapter(ports)?.ensureReady();
app.enableShutdownHooks();
await app.listen(settings.port, '0.0.0.0');
console.info(JSON.stringify({ event: 'api.started', port: settings.port, version: settings.version, aiEnabled: settings.aiEnabled }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { await app.close(); await shutdown(); process.exit(0); });
}
