# BUILD-BASELINE — POII

Version 1 · 2026-10-09 · Status: active baseline for release one.

This file is the single baseline. Every agent (Claude Code, Codex, Cursor, ChatGPT) and every person works from it and from the ADRs in `docs/adr/`. Nobody keeps a parallel plan. Changes to this file go through a PR; see [the release policy](docs/release-policy.md) for which changes are gated.

The owner's decisions of 2026-10-09 (recorded privately, outside this repository) settle scope, identity, ownership, delivery and delegation. This baseline applies them. It does not reopen them.

## 1. What POII is

POII (Personal/Organizational Intelligence Infrastructure) is an owner-controlled record of evidence, decisions, authority, change history and current state. It gives a person, or any AI, the relevant current context with exact sources: who decided what, what it replaced, what was actually built or observed, and what is still unknown.

AI providers are replaceable workers; POII keeps the knowledge. POII is an independent peer: people, organizations, external apps and AI agents can use it in both directions, and it keeps working when fully detached from every other peer and from every AI provider.

Principles that are not negotiable in the code:

- **Attribution is not approval.** Who said something (and in what role, quoted or pasted) is recorded separately from who decided it, with what authority, replacing what. Pasted assistant text is never recorded as the owner's statement.
- **AI output is a candidate** until a person with authority confirms it. Model confidence never grants authority. A token can propose but never confirm.
- **Sources are immutable.** Re-import creates a revision. Every derived item opens its source at the exact span.
- **Current state is derived**, never edited: current decisions = confirmed decisions minus superseded ones. A superseded decision never shows as current.
- **Three times on every record**: recorded, effective, observed. Unknown and conflicting stay explicit.
- **Permissions pass down.** A source's "never send to AI" flag covers everything derived from it. Deletion propagates to indexes and future exports.
- **"Never out of sync" is measurable**: last observed, stale, unknown and disconnected are shown honestly.
- **Instructions inside sources never execute.** Source content is data on every interface.

## 2. Settled decisions as applied

| Decision | Applied in this baseline |
| --- | --- |
| ND-1 Release one | The complete manual workflow (works with AI and peers off) plus optional AI-assisted candidate extraction. Release-one exclusions and the three acceptance fixtures are kept (§3, §8). |
| ND-2 Identity | Identity port from day one. Adapters: local/standalone (Better Auth, chosen after the evaluation recorded in ADR-0009) and AccessLobby OIDC (Authorization Code + PKCE; store issuer, sub, person.id; explicit linking with proof of both accounts; no email merge; no automatic fallback during an outage; "this app / all apps" sign-out). Scoped, expiring, revocable owner tokens that read and propose but never confirm. ADR-0004. |
| ND-3 Ownership | One writable master per record. Git: POII code, specs, ADRs. POII database: decisions, evidence, notes recorded in POII. Other systems: their own records. Views, indexes, context packs: rebuildable. KnowledgeMesh is absorbed into POII. MindMesh keeps its own ordinary memories and runs without POII; POII runs without MindMesh; shared records move only by explicit copy or promotion with origin, version, conflict and deletion rules. ADR-0001. |
| ND-4 Delivery | GHCR images identified by digest, Dokploy on existing Hetzner capacity, separate POII database, staging first, existing backup target, restore drill. Manual refresh and staleness labels in release one. Repository public; no LICENSE file for now (all rights reserved until the owner decides). Routine releases follow continuous deployment (docs/release-policy.md). ADR-0006. |
| ND-5 Delegation | Next.js PWA, NestJS modular monolith, PostgreSQL, Drizzle as the one ORM/migration tool, pnpm, Docker, object-storage port (local/S3 now), Redis/BullMQ only when needed. No Payload, no Supabase. The builder decides UI/UX and routine engineering and records material choices as short ADRs. Escalation to the owner only for gated classes and the first production activation. ADR-0002, ADR-0003. |
| Product AI | Anthropic API and OpenAI API through the AI-execution port, each with a hard cap of USD 20/month enforced inside POII on top of provider-side limits. AI is off until keys and caps are configured. ADR-0007. |

## 3. Scope of release one

Release one = M1 + M2 below. Until the owner accepts release one, these stay out: a chat interface, bulk import of all past chats, automatic ChatGPT sync, MCP write tools, scheduled drift detection, organization administration, a separate KnowledgeMesh, research workflows (ResearchFlow's job), native mobile/offline sync, billing. Also avoided until the core journey is in daily use: speculative services, generic frameworks, graph canvases, vector search.

## 4. Journeys

### 4.1 Manual journey (M1, must pass with AI and peers off)

1. Paste or upload text or Markdown. The original is kept unchanged with exact locators (revision, character offsets, line/column, excerpt hash).
2. Create candidates by hand: fact, requirement, decision, question. Each cites one or more source spans.
3. Confirm, edit, reject or supersede candidates, with full history. Confirming creates an approval that names the approver, their authority and the exact antecedent being replaced, if any.
4. Set lifecycle status: proposed, decided, implemented, observed, unknown.
5. Full-text search, then open the original at the exact span.
6. See the current-decisions view, derived from approvals plus supersession.
7. Export a cited context pack (Markdown and JSON) that lists included, excluded and unavailable sources.
8. Back up the workspace and restore it into a clean install.

### 4.2 AI-assisted journey (M2, optional)

1. Choose a source (or span) and an action; see a preview of exactly what will be sent to which provider.
2. Sources marked "never send to AI" cannot be selected and never appear in a provider request or its logs.
3. The provider returns candidates. They stay candidates with attribution `ai_extracted` until a person confirms them.
4. Usage and remaining cap are visible. At the cap, AI actions stop and the manual path continues.

### 4.3 Connected journeys (M3)

Sign in through AccessLobby with explicit account linking; read-only API and MCP read tools; export to `AGENTS.md`/`CLAUDE.md`; import of selected ChatGPT and Claude export conversations; opt-in Claude Code hook capture; compatibility matrix; MindMesh execution-adapter contract (interface and documentation only).

## 5. Domain model

Identifiers are UUIDv7 (time-ordered, stable, generated by the API). Nothing is keyed by a mutable name.

| Entity | What it is | Key rules |
| --- | --- | --- |
| `workspace` | The private owner workspace. One in release one. | Every record belongs to exactly one workspace. |
| `actor` | A person, an AI assistant, an agent token or the system. | Only person actors can hold authority. Attribution and approval both reference actors, in separate fields. |
| `source` | An imported original: paste, upload or later import. | Immutable content via revisions. Carries `ai_allowed` (false = never send to AI), `archived_at`, origin metadata. Hard delete leaves a `source_tombstone` (id, content hash, deleted time) so exports can say "unavailable: deleted" and re-imports stay idempotent. |
| `source_revision` | One immutable version of a source's content. | Content, SHA-256, byte and line counts. A re-import with different content adds a revision; identical content is a no-op. |
| `locator` | Where in a revision a span lives. Stored on `record_evidence`. | Revision id, start/end character offsets, start/end line, excerpt and excerpt hash. If the revision changes, the excerpt is re-anchored by search and the result is labelled exact, moved or lost. |
| `record` | A fact, requirement, decision or question. | `review_state`: candidate, confirmed, rejected. `lifecycle_status`: proposed, decided, implemented, observed, unknown. Attribution: `stated_by_actor_id`, `stated_role` (owner, assistant, third_party, unknown), `statement_mode` (quoted, pasted, paraphrased, ai_extracted). Times: `recorded_at` (always known), `effective_at` and `observed_at` each with a status of known, unknown, not_applicable or conflicting. Supersession: `supersedes_record_id`; the reverse link is derived. |
| `record_version` | Snapshot of a record after each change. | Append-only. Change kinds: create, edit, confirm, reject, supersede, status. |
| `record_evidence` | Link from a record to a source span. | Role primary or supporting. Survives source deletion as "unavailable" with the original source id. |
| `approval` | A person with authority confirming a record. | `approved_by_actor_id`, `authority` (owner, delegated), `approved_at`, `antecedent_record_id` (what this replaces), note. Never created by a token actor. The only way a record becomes confirmed. |
| `audit_event` | Append-only log of every mutation. | Actor, action, target, time, request id. |
| `export_run` | A generated context pack or backup. | Format version, selection, manifest of included, excluded and unavailable sources, content hash. Rebuildable. |

Derived, rebuildable projections: full-text search (PostgreSQL `tsvector` generated columns), the current-decisions view, context packs, and later vectors.

Invariants enforced in the API and covered by tests:

- A record whose evidence includes any `ai_allowed = false` source is itself never sent to a provider.
- A confirmed record with a confirmed successor is never current.
- Deleting a source removes its content and search entries immediately and marks dependent evidence unavailable in every later export.
- Duplicate imports (same workspace, same content hash, same origin key) return the existing source. Retried writes with the same idempotency key return the first result.
- An actor of kind `agent_token` can create candidates and read context but cannot create approvals, change review state to confirmed, or delete.

## 6. Ports and adapters

| Port | Release-one adapters | Later |
| --- | --- | --- |
| Identity | `local-owner` (single owner, development and standalone); local sign-in on Better Auth (ADR-0009) | AccessLobby OIDC with explicit linking; AccessLobby machine identities |
| Storage (originals and backups) | Local filesystem; S3-compatible | DonLoft |
| AI execution | Anthropic API; OpenAI API; `off` (manual only) | MindMesh routing |
| Search | PostgreSQL full-text | Vectors, rebuildable from sources |
| Queue | None (synchronous) | Redis/BullMQ only when a real need appears |

Every port has one interface in `apps/api/src/ports/`, adapters in `apps/api/src/adapters/`, and a contract test that each adapter must pass.

## 7. Architecture and stack

- Monorepo with pnpm workspaces: `apps/api` (NestJS modular monolith, TypeScript), `apps/web` (Next.js app router, PWA), `packages/contracts` (shared types, zod schemas, export format).
- PostgreSQL 17. Drizzle ORM with SQL migration files generated by drizzle-kit and applied by one migration runner (`apps/api/src/migrate.ts`). Expand/contract only; see ADR-0003.
- Docker images per app, built in CI, pushed to GHCR, deployed by digest through `compose.dokploy.yaml`.
- Local development: `compose.yaml` runs PostgreSQL; the apps run with `pnpm dev`.
- Tests: `node --test` unit and integration tests (integration against a real PostgreSQL), Playwright smoke of the core journey.

## 8. Acceptance

Release one is done when all of the following pass on the three public fixtures with AI and peers switched off:

1. Every manual journey step (§4.1), end to end.
2. Restore into an empty install reproduces the workspace, including history and approvals.
3. A superseded decision never appears as current. Every derived item opens its source span. Context-pack citations resolve.
4. Pasted assistant text is never recorded as the owner's statement. An approval links to its exact antecedent.
5. Missing or conflicting dates stay explicit. Intent and observed reality can differ, and both are shown.
6. Instructions hidden inside sources never execute. Duplicate imports and retries are idempotent.
7. Access rules and token scopes hold on every interface. A token can propose but not confirm. Revocation takes effect immediately.
8. "Never send to AI" content never appears in a provider request or its logs. Deletion removes items from search and from future exports.
9. Caps stop AI calls at the limit. The manual path keeps working when providers or peers are down.
10. No secrets or private evidence in the repository, images, logs or artifacts.

Public fixtures (fictional or sanitized, in `fixtures/`):

1. `decision-chain`: a decision chain containing pasted assistant text and a supersession.
2. `intent-vs-observed`: an intended design versus the observed implementation.
3. `price-conflict`: two conflicting product prices from different sources and which one was approved, by whom.

Real data stays in the owner's private local instance and never enters this repository.

## 9. Release policy

Continuous deployment for routine changes; gated classes wait for the owner. The full policy, the gated classes and the safety rules are in [docs/release-policy.md](docs/release-policy.md). Path-based classification lives in `.github/release-policy/risk-classes.json`. The first production activation needs the owner's explicit activation phrase after staging is green, the restore drill has passed and the secrets are set.

## 10. Milestones

| Milestone | Content | Estimate (revised after M0) |
| --- | --- | --- |
| M0 Foundation | This baseline, ADRs, repository seed, CI, owner setup list. | Done 2026-10-09. |
| M1 Local manual journey | §4.1 on local Docker PostgreSQL, fixtures, backup/restore, dogfooding on the owner's private instance. | 1–3 working days of agent sessions. |
| M2 AI-assisted alpha on staging | AI port with Anthropic and OpenAI adapters, previews, caps, local sign-in, scoped tokens, staging on Dokploy with continuous deployment, backups and restore drill, health and version endpoints. | About 1–2 weeks, paced by the owner's setup tasks. |
| M3 Connected and portable | AccessLobby OIDC, read-only API and MCP read tools, exports to agent files, selected conversation imports, hook capture, compatibility matrix, MindMesh adapter contract. | Continuous increments after release one. |

## 11. Repository conventions

- Read `AGENTS.md`, `SOURCE-OF-TRUTH.md`, `CURRENT-WORK.md` and this file before editing.
- Trunk-based work: small PRs, squash merges, every change through a PR. `CURRENT-WORK.md` records what was actually tested, with exact SHAs and run links; mocked work is labelled mocked.
- `LIVE-ENVIRONMENT-FACTS.md` records observed deployments by digest, separately from CI results.
- No private evidence, real conversations, personal names, business data, credentials or `.env` files in Git, images, logs, artifacts or screenshots.
