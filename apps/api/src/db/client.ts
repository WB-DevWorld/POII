import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

export type Db = {
  pool: Pool;
  orm: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
};

/**
 * How long a query waits for a connection: a new one to Postgres, or a free one when all `max` are busy.
 * pg's default is to wait for ever, which turns an unreachable database into requests that never answer.
 */
export const DB_CONNECTION_TIMEOUT_MS = 10_000;

export function createDb(connectionString: string, max = 10): Db {
  // keepAlive lets the operating system notice a connection whose other end is gone.
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS, keepAlive: true });
  // An idle connection that breaks is dropped by the pool. Without a listener the event would end the process.
  pool.on('error', error => console.error(`[db] idle connection lost: ${error.message}`));
  const orm = drizzle(pool, { schema });
  return { pool, orm, close: () => pool.end() };
}
