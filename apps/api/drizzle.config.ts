import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  migrations: { table: 'poii_migrations', schema: 'public' },
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://poii:change-me-locally@localhost:5433/poii' },
  strict: true,
  verbose: true,
});
