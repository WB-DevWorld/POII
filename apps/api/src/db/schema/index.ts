// Drizzle schema. The domain tables (BUILD-BASELINE.md §5, ADR-0005) arrive in the first PR
// after the seed; this file is the single schema entry point drizzle-kit reads.
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const instanceInfo = pgTable('instance_info', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
