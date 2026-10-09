# POII

Personal/Organizational Intelligence Infrastructure: an owner-controlled record of evidence, decisions, authority, change history and current state. It gives a person, or any AI, the relevant current context with exact sources: who decided what, what it replaced, what was actually built or observed, and what is still unknown.

Own the knowledge, rent the intelligence. AI providers are replaceable workers; POII keeps the record.

- Start with [BUILD-BASELINE.md](BUILD-BASELINE.md): scope, journeys, data model, ports, acceptance and release policy.
- Decisions are in [docs/adr/](docs/adr/). What is run and tested is in [CURRENT-WORK.md](CURRENT-WORK.md). What is deployed is in [LIVE-ENVIRONMENT-FACTS.md](LIVE-ENVIRONMENT-FACTS.md).
- Agents read [AGENTS.md](AGENTS.md) first.

## Run locally

Requirements: Node 24 LTS, pnpm 11, Docker.

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres
cp .env.example .env
pnpm --filter @poii/api migrate
pnpm dev
```

The web app is on http://localhost:3000 and the API on http://localhost:3001. The default local identity adapter signs you in as the single owner; AI is off until providers are configured.

## Licence

All rights reserved. No licence has been granted yet; the owner will decide later.
