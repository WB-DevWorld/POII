import { Controller, Get, Inject, Res } from '@nestjs/common';
type Response = { setHeader(name: string, value: string): unknown; status(code: number): Response; json(body: unknown): unknown };
import type { Settings } from './config.js';
import type { Db } from './db/client.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject('SETTINGS') private readonly settings: Settings,
    @Inject('DB') private readonly db: Db,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', version: this.settings.version };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    res.setHeader('cache-control', 'no-store');
    try {
      await this.db.pool.query('SELECT 1');
      res.json({ status: 'ready', version: this.settings.version, aiEnabled: this.settings.aiEnabled });
    } catch {
      res.status(503).json({ status: 'unavailable', version: this.settings.version });
    }
  }
}
