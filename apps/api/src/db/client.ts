import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

export type Db = {
  pool: Pool;
  orm: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
};

export function createDb(connectionString: string, max = 10): Db {
  const pool = new Pool({ connectionString, max });
  const orm = drizzle(pool, { schema });
  return { pool, orm, close: () => pool.end() };
}
