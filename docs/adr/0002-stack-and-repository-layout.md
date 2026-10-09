# ADR-0002 Stack and repository layout

Status: accepted · 2026-10-09 · Within the owner's ND-5 delegation.

## Decision

- pnpm workspace: `apps/api` (NestJS 12 modular monolith, TypeScript 5.9, ESM), `apps/web` (Next.js 16 app router, React 19, PWA), `packages/contracts` (shared types, zod schemas, export format). Fixtures in `fixtures/`. Infrastructure scripts in `infra/`.
- PostgreSQL 17 is the only database. No Redis or queue until a measured need appears.
- Tests use `node --test` with `tsx`; integration tests run against a real PostgreSQL via `TEST_DATABASE_URL` and are skipped, not faked, when it is absent. Playwright runs the core-journey smoke.
- Images are built from `apps/*/Dockerfile` on Node 24 LTS Alpine and deployed by digest through `compose.dokploy.yaml`, following the AccessLobby conventions.
- The API is the only writer to the database. The web app talks to the API over HTTP through `API_INTERNAL_URL`.

## Why

It is the stack the owner named, it matches the sibling AccessLobby repository so agents can move between them, and it keeps the number of moving parts small until the core journey is in daily use.

## Consequences

No Payload, no Supabase, no graph canvas, no chat UI in release one. Adding a service requires an ADR.
