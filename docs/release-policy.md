# Release policy — continuous deployment with gated classes

Version 1 · 2026-10-09 · Approved by the owner with the build commission of 2026-10-09. Later changes to this file are gated.

## Pull requests and CI

- Trunk-based work with small PRs and squash merges. Every change goes through a PR; nothing is pushed to `main` directly after the seed commit.
- CI on every PR: frozen install, lint, typecheck, unit tests, integration tests against PostgreSQL, migrations from empty and from the previous release, build, Playwright smoke of the core journey, secret scanning (gitleaks plus GitHub push protection), dependency review and Dependabot, and CodeQL.
- A ruleset protects `main` and requires these checks.
- Routine PRs auto-merge when green. Gated PRs wait for the owner's explicit approval.

## Release path

1. On merge to `main`, CI builds one immutable image per app and pushes it to GHCR, tagged with the commit SHA and identified by digest.
2. That digest is deployed to staging automatically.
3. Smoke, acceptance and migration checks run on staging.
4. If the change is routine and staging is green, the same digest is promoted to production automatically.

Gated changes go through the `production-gated` GitHub environment with the owner as required reviewer. Anything unclassified counts as gated.

## Gated classes

- Identity, auth, permissions or tokens.
- Information policy: disclosure, retention, deletion.
- Canonical ownership or the data model.
- Destructive or backward-incompatible migrations.
- New spending, or changes to the caps.
- Licence or repository visibility.
- Changes to other peers.
- The release workflows, the risk classifier and this policy itself. Their initial setup is approved; later changes are gated.
- The first production activation.

## Classification

- Classification is path-based and lives in `.github/release-policy/risk-classes.json`, a protected file with the owner as CODEOWNER. The `risk-classify` workflow applies it to every PR and reports the class as a check and a label.
- Labels can raise the risk class (`risk:gated`), never lower it. A PR that touches a gated path is gated whatever its labels say.
- A PR that cannot be classified is gated.

## Rules that keep it safe

- Deploys run one at a time. A running migration is never cancelled. The previous digest is kept for one-step rollback. Rolling back the app and restoring the database are separate procedures with separate runbooks.
- Agents never read, print or hold production credentials. Deploy credentials live in GitHub environments and in Dokploy, scoped to `main`.
- **Approval identity.** Agent commits and PRs should come from a separate bot account or GitHub App, so that the owner's approvals gate something. Until that identity exists, agents act through the owner's account. In that period gated items wait for the owner's approval phrase in chat, recorded in `CURRENT-WORK.md`, and agents never call approval or bypass endpoints.
- **First production activation** needs the owner's phrase `POII PRODUCTION ACTIVATION APPROVED`, given after staging is shown green, the restore drill has passed and the secrets are set. After that, routine releases go out without the owner.

## What is recorded where

- CI results: on the PR and in `CURRENT-WORK.md` with exact SHAs and run links.
- Published digests: in the publish workflow summary and in `infra/releases/`.
- Observed deployments and health: in `LIVE-ENVIRONMENT-FACTS.md`, separately from CI success.
- Owner approvals of gated items: in `CURRENT-WORK.md`, quoting the approval phrase and date.
