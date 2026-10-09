# Execution ledger

Newest entry first. Every entry says what was run and what was not. Mocked work is labelled mocked.

## M1 foundation merged — 2026-10-09 UTC

[PR #10](https://github.com/WB-DevWorld/POII/pull/10) merged as `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02`: domain schema and migration `0001_domain_model` (ADR-0005), the HTTP contract (`packages/contracts/src/api.ts`, `docs/api.md`), the three fictional fixtures, and the CI move to the ECR Public mirror of the official images. CI on the PR head: `verify` PASS (2m42s, [run 37995561095](https://github.com/WB-DevWorld/POII/actions/runs/37995561095)): gitleaks history scan, forbidden-material check, frozen install, audit, lint, typecheck, migrations from empty, upgrade check (skipped by design: no previous migrations differed), unit and PostgreSQL integration tests, build, Playwright smoke, Compose validation, both container builds, API container readiness. `classify` PASS (class: gated, data model), `dependency-review` PASS, CodeQL `analyze` PASS.

Risk note: the PR was gated by path (data model). It is the first implementation of the model that the owner's build commission of 2026-10-09 mandated; the integrator merged it on that basis and recorded the reasoning in the PR. Every later schema change waits for the owner's approval phrase.

Tracking issues #11–#23 cover M1, M2 and M3 work packages.

Not run: staging, production, backup, restore drill, AccessLobby integration, image publication (the publish workflow runs after this merge; digests are recorded in `LIVE-ENVIRONMENT-FACTS.md` only once observed).

## M0 seed — 2026-10-09 UTC

Seeded `main` (`eef86bd`) with the baseline, ownership and ADR-0001..0008, governance files, CI, release-policy classification, workspace skeleton and local Compose. The owner's decisions were verified against their private record (hash match) before the baseline was written. The remote was empty before the seed.

The seed's own CI run on `main` failed twice on the Docker Hub unauthenticated pull limit for `postgres:17` (not on project checks); fixed in PR #10 by using the ECR Public mirror.

Repository settings applied on the owner's account: squash-only merges, delete branch on merge, auto-merge allowed, secret scanning with push protection, Dependabot alerts and security updates, ruleset `Protect main` (PR required, squash only, linear history, required checks `verify`, `classify`, `dependency-review`, `analyze`, no bypass), environments `staging` and `production-gated` (owner as required reviewer), labels `risk:gated` and `risk:routine`. Dependabot PRs for Node 26 images and TypeScript 7 were closed as deliberate non-upgrades.
