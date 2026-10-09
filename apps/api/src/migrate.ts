// The single migration authority (ADR-0003). Applies every apps/api/drizzle/*.sql file in order,
// one transaction per file, and records name and SHA-256 in poii_migrations. Re-running is a no-op.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export async function runMigrations(databaseUrl: string, dir: string, log: (line: string) => void = console.info) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS poii_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>();
    for (const row of (await client.query('SELECT name, sha256 FROM poii_migrations')).rows) applied.set(row.name, row.sha256);
    const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
    let count = 0;
    for (const name of files) {
      const sql = readFileSync(join(dir, name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(name);
      if (previous === sha256) continue;
      if (previous) throw new Error(`Migration ${name} was applied with a different content hash; migrations are immutable`);
      await client.query('BEGIN');
      try {
        await client.query(sql.split('--> statement-breakpoint').join('\n'));
        await client.query('INSERT INTO poii_migrations(name, sha256) VALUES ($1, $2)', [name, sha256]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      count += 1;
      log(`applied ${name}`);
    }
    log(`${count} migration(s) applied, ${files.length - count} already present`);
    return { applied: count, total: files.length };
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const dir = process.env.POII_MIGRATIONS_DIR ?? fileURLToPath(new URL('../drizzle', import.meta.url));
  await runMigrations(databaseUrl, dir);
}
