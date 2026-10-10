# ADR-0010 Staging deploy mechanics

Status: proposed · 2026-10-10 · Implements release policy steps 1–3 (ADR-0006) for staging. Not yet run against Dokploy. Runbook: `docs/runbooks/staging-deploy.md`.

## Decision

- **Trigger and switch.** `Deploy staging` runs after each successful `Publish immutable images` run on `main`, and by manual dispatch with a source SHA. It is a no-op until the repository variable `POII_STAGING_ENABLED` is `true`; a manual `dry_run` only reads Dokploy and is allowed while it is off.
- **Where the secrets are released.** The Dokploy secrets live only in the `staging` GitHub environment, whose deployment branches are limited to `main` (Selected branches: `main` only, no required reviewers). That environment rule is the control; the branch check inside the workflow is not, because a workflow dispatched from another branch runs that branch's copy of the file. The first dry run must show the job ran under `staging`.
- **What gets deployed.** The digests come from the publish run's `poii-release-<sha>` artifact and must match what the GHCR `sha-<sha>` tags point at. Nothing is deployed by tag.
- **How Dokploy is driven.** Through its HTTP API with an API key: only `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA` in the Compose service environment are rewritten, every other line is kept, the stored value is read back before deploying, then `compose.deploy` is called and its deployment polled by a unique title. Any response the script does not recognise stops the run. Dokploy autodeploy stays off so this workflow is the only way staging changes.
- **How the API is observed from outside.** Dokploy routes the path `/health` on the staging web host to the `api` service (``Host && PathPrefix(`/health`)``). Only the health endpoints are public; the rest of the API stays on the internal network. A separate API hostname is the fallback, set through `STAGING_API_BASE_URL`.
- **Evidence.** The workflow writes the release manifest to its summary and as an artifact but never pushes; the agent records it in `infra/releases/` and `LIVE-ENVIRONMENT-FACTS.md` through a normal PR, because the `main` ruleset forbids direct pushes.
- **Failure.** One deploy at a time (`deploy-staging`, no cancel-in-progress). A failed deploy is reported with the previous values and the rollback runbook; nothing is rolled back or cancelled automatically, so a running migration is never interrupted.

## Consequences

Merging changes nothing until the owner configures Dokploy, the `staging` environment and the switch. Staging cannot become ready while the API refuses local-owner on a public host (ADR-0004) unless the owner deliberately allows it or local sign-in (#14) lands; the core-journey Playwright smoke on staging waits for an approved staging sign-in method. Dokploy's API responses are largely undocumented, so a Dokploy upgrade can stop deploys loudly until the script is adjusted; a dry run after each upgrade catches this.
