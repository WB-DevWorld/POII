# ADR-0003 Drizzle ORM and expand/contract migrations

Status: accepted · 2026-10-09 · Within ND-5 ("one ORM/migration tool").

## Decision

- Drizzle ORM is the single ORM. The schema lives in `apps/api/src/db/schema/`.
- drizzle-kit generates plain SQL migration files into `apps/api/drizzle/`. They are reviewed in the PR like code and are the only migration authority. Nothing else alters the schema (no `push`, no manual `ALTER` in production).
- One runner, `apps/api/src/migrate.ts`, applies migrations in order inside a transaction per file and records them in `poii_migrations`. It runs as the `migrate` service before the API starts.
- Expand/contract only. A change first adds (expand) while old code still works; the removal (contract) ships in a later release after the previous digest no longer runs. Contract migrations are named `*-contract-*` and are a gated class.
- CI applies migrations from empty and from the previous release's migration set on top of a fresh database.
- Full-text search uses generated `tsvector` columns and GIN indexes in SQL migrations.

## Why

SQL-first migrations are reviewable, path-classifiable and portable. Drizzle adds typed queries without hiding the SQL, which matters for locators, full-text search and the audit trail.

## Consequences

Every migration, generated or hand-written, is committed with its `meta/NNNN_snapshot.json`; CI fails when `drizzle-kit generate` is not a no-op for the committed schema (`infra/scripts/migration-snapshot-check.sh`, added 2026-11-26 after migrations 0002 to 0005 were found to have none).

Never cancel a running migration. Rolling back the app (previous digest) and restoring the database are separate procedures.
