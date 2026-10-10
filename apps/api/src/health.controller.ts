import { Controller, Get, Inject, Res } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import { desc } from 'drizzle-orm';
type Response = { setHeader(name: string, value: string): unknown; status(code: number): Response; json(body: unknown): unknown };
import type { Settings } from './config.js';
import type { Db } from './db/client.js';
import { opsBackupRun } from './db/schema/index.js';
import { buildInfo, type BuildInfo } from './ops/ops-config.js';

const migrationName = (file: string) => file.replace(/\.sql$/, '');

@Controller('health')
export class HealthController {
  private readonly build: BuildInfo = buildInfo();

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

  /**
   * What is running: the commit, build time, Node version, the newest applied and newest shipped migration, and the
   * last backup run. Informational only: every part degrades to null, and readiness never looks at any of it.
   */
  @Get('version')
  async version(@Res() res: Response) {
    res.setHeader('cache-control', 'no-store');
    res.json({
      version: this.settings.version,
      builtAt: this.build.builtAt,
      node: process.version,
      migrations: { applied: await this.appliedMigration(), latest: this.latestMigration() },
      backup: await this.lastBackup(),
    });
  }

  private latestMigration(): string | null {
    try {
      const files = readdirSync(this.build.migrationsDir).filter(name => name.endsWith('.sql')).sort();
      return files.length ? migrationName(files[files.length - 1]!) : null;
    } catch {
      return null;
    }
  }

  private async appliedMigration(): Promise<string | null> {
    try {
      const row = (await this.db.pool.query<{ name: string }>('SELECT name FROM poii_migrations ORDER BY name DESC LIMIT 1')).rows[0];
      return row ? migrationName(row.name) : null;
    } catch {
      return null;
    }
  }

  private async lastBackup(): Promise<{ lastRunAt: string; lastTarget: string; lastStatus: string } | null> {
    try {
      const row = (await this.db.orm.select().from(opsBackupRun).orderBy(desc(opsBackupRun.startedAt), desc(opsBackupRun.id)).limit(1))[0];
      return row ? { lastRunAt: row.startedAt.toISOString(), lastTarget: row.target, lastStatus: row.status } : null;
    } catch {
      return null;
    }
  }
}
