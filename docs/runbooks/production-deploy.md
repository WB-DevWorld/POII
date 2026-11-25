# Production deploy

How `.github/workflows/deploy-production.yml` promotes a release from staging to production (release policy step 4), what the owner has to set up first, the first activation, and what to do when it fails. Decisions behind it: [ADR-0013](../adr/0013-production-promotion-mechanics.md). The staging half is [staging-deploy.md](staging-deploy.md).

**Status: written, never run. No production exists.** No Dokploy production service, no `production` GitHub environment and no production secrets exist. The hostname `https://poii.cetechbpa.com` is reserved and serves nothing. The workflow has never run on GitHub. `infra/scripts/promotion-class.mjs` was exercised against a mock of the GitHub API, and its read-only calls once against this repository (2026-11-25). The deploy steps are the staging ones, which have run on staging since 2026-11-24.

## What happens on merge

Nothing. The workflow starts after every successful `Deploy staging` run on `main`, but its first job stops with a step summary saying production deploys are switched off, until the **repository variable** `POII_PRODUCTION_ENABLED` is `true`. The `deploy` job, the only job that uses an environment and its secrets, is skipped. No Dokploy request is made. The only exception is a manual dispatch with `dry_run`, which reads GitHub and Dokploy and changes nothing.

## What one run does

1. **Gate** (no environment, no secrets; `contents`, `actions` and `pull-requests` read).
   1. Checks `POII_PRODUCTION_ENABLED`. A manual dispatch must come from `main` with `source_sha` (40 lowercase hex).
   2. Finds the staging release (`promotion-class.mjs resolve`):
      - after a staging run: the manifest artifact `poii-staging-manifest-<sha>-<attempt>` of the attempt that just finished. If there is none (staging was switched off, was a dry run, or had nothing to deploy), the run ends as a no-op.
      - manual dispatch: the newest unexpired staging manifest artifact for that SHA (attempts 1 to 10 are tried). Artifacts are kept 90 days. A source staging never deployed cannot be promoted.
      - Either way the producing run must be a successful `main` run of `.github/workflows/deploy-staging.yml` in this repository.
   3. Downloads that artifact and checks the manifest (`promotion-class.mjs classify`): exactly one file, named `staging-<UTC time>-<sha12>.json`; `environment` is `staging`; `sourceSha` is the SHA; `observedReadyVersion` equals `sourceSha`; both image references match `ghcr.io/wb-devworld/poii-{api,web}@sha256:<64 hex>`. Anything else fails the run.
   4. Finds the previous production source: the newest successful `main` run of `deploy-production.yml` that uploaded `poii-production-manifest-<sha>-<attempt>` (the newest 100 successful runs are searched). If GitHub cannot be asked, the run fails.
   5. Decides the promotion class (next section) and writes the commits, pull request numbers, risk labels and reasons to the summary. That summary is what the owner reads before approving.
2. **Deploy job**, in the environment `production` (class `routine`) or `production-gated` (anything else; waits for the owner's approval). Concurrency group `deploy-production`, `cancel-in-progress: false`.
   1. Checks the secrets and the variable exist (names only).
   2. Looks at the production history again (`promotion-class.mjs recheck`), because the gate may have looked hours or days before the approval. See "Waiting runs and newer commits".
   3. Downloads the previous production manifest and checks it (`environment: production`, the SHA, the file name). Its file name becomes `previous`.
   4. Checks that the GHCR tags `sha-<sha>` point at the digests from the staging manifest.
   5. `infra/scripts/dokploy-deploy.mjs` with the production compose id: first requires that the service's own `WEB_BASE_URL` equals `PRODUCTION_WEB_BASE_URL` (`EXPECT_WEB_BASE_URL`; a compose id that names the staging service stops here, before any change), then rewrites exactly `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA`, reads the service back, deploys with the title `POII production <sha> run <run id>.<attempt>` and polls the deployment for at most 20 minutes. It never cancels a deployment. Details: [staging-deploy.md](staging-deploy.md#what-one-run-does) step 5.
   6. `infra/scripts/staging-smoke.sh wait` against the production host: `/health/ready` must report the SHA within 10 minutes.
   7. `infra/scripts/staging-smoke.sh check` against the production host: `/health/live`, `/health/ready`, the web root, an unknown route. It is the staging script, pointed at production through `POII_WEB_BASE_URL`; its output says "staging smoke" and names the production host. The Playwright core-journey smoke is skipped with a printed reason, as on staging.
   8. Writes the manifest `production-<UTC yyyymmddThhmmssZ>-<sha12>.json` (format in `infra/releases/README.md`) to the summary and as the artifact `poii-production-manifest-<sha>-<attempt>` (kept 90 days).

**Dry run.** A manual dispatch with `dry_run: true` does all of step 1, then steps 2.1 to 2.5 with Dokploy only read. It changes nothing, skips steps 2.6 to 2.8 and is allowed while `POII_PRODUCTION_ENABLED` is off. It runs in the environment its class selects, so before the first deploy it waits for the owner's approval in `production-gated` like the real run will.

## Promotion class

The class is decided for the whole range between the previous production source and the new one, because a digest contains every commit before it.

| Situation | Class |
|---|---|
| Every commit in the range came in through a merged pull request into `main` labelled `risk:routine` and not `risk:gated` | `routine` |
| A pull request in the range is labelled `risk:gated` | `gated` |
| A commit has no merged pull request into `main` of this repository, or the pull request has no `risk:routine` label | `gated` |
| No previous production deploy (the first deploy), or its manifest artifact has expired | `gated` |
| The previous source is not an ancestor of the new one (a rollback to an older source) | `gated` |
| The source is the one production already runs | after a staging run: nothing is promoted; manual dispatch: `gated` |
| More than 500 commits in the range, or GitHub cannot answer for a commit | `gated` |

The labels are the ones the required `classify` check sets on every pull request. Only SHAs, pull request numbers and the two risk labels are printed.

A PR that records a release manifest under `infra/releases/` is gated by path. The promotion that contains it is therefore gated too (ADR-0013, consequences).

## Waiting runs and newer commits

What was chosen:

- One deploy at a time. A running deploy is never cancelled; a migration may be running.
- Nothing overtakes a gated change. While a gated change is not in production, every later run covers a range that contains it and is gated as well.
- The owner may approve any waiting run. Approving the newest one deploys everything up to it.
- After any approval the deploy job compares the production history with what the gate saw:
  - unchanged: it deploys;
  - production moved forward to an ancestor of this run's source: it deploys if the run was approved in `production-gated`, or if the shorter range is still routine;
  - production already runs this source or a later or unrelated one: the run ends green with "Superseded" and does not touch Dokploy;
  - a routine run whose range is now gated, or a history that cannot be read: the run fails before Dokploy is touched. Start a new run.
- A later run that was classified gated still needs its own approval, even if the gated change it contained has been deployed in the meantime by an earlier run.
- A dry run has its own concurrency group. It never waits behind a deploy and never displaces one.

Not verified, because no run exists:

- Whether a job waiting for approval already holds the concurrency group. If it does, later runs queue behind it, and GitHub keeps only the newest queued run and cancels the older queued ones; rejecting the waiting run frees the queue. If it does not, several runs can wait for approval at once. Both are safe with the check above; the difference is how many waiting runs the owner sees.
- GitHub's documentation says a job that waits for review fails after 30 days. A gated promotion nobody approves ends that way; the next staging deploy starts a new one.
- Whether "prevent self-review" on `production-gated` stops the owner from approving a run that descends from the owner's own action. The staging runs of 2026-11-24 and 2026-11-25 list the owner's account as their actor, because the owner merged the pull requests. If GitHub refuses the approval, either the agent identity merges approved gated PRs and starts manual runs, or the owner turns that setting off. The dry run of the first activation shows which it is: let the agent start it.
- Whether GitHub starts this workflow at all for every chain. CI → publish → staging → production is three chained `workflow_run` levels, the documented maximum. If a production run is missing after a green staging deploy, start it by hand with the source SHA.

## Owner setup (before switching it on)

These extend [owner setup §5](owner-setup.md#5-dokploy-on-the-existing-hetzner-capacity) and mirror [staging-deploy.md](staging-deploy.md#owner-setup-before-switching-it-on).

### In Dokploy

1. **Compose service** for production from `compose.dokploy.yaml`, in the POII project, Isolated Deployment off, source = this repository, branch `main`, **Autodeploy off**. It is a second service next to staging, not a copy of its settings.
2. **Environment** of that service, with its own values: a new `POSTGRES_PASSWORD` and a new `POII_SESSION_SECRET` (never the staging ones), `WEB_BASE_URL=https://poii.cetechbpa.com`, the identity settings staging uses (the Compose defaults refuse a public host, ADR-0004 and ADR-0009), and initial `API_IMAGE`, `WEB_IMAGE`, `GIT_SHA` (the pair staging serves). AI keys and caps only if AI is to run in production; that is new spending and a gated decision. The backup target variables as in [backup-and-restore-drill.md](backup-and-restore-drill.md), with a production location of its own.
3. **Volumes.** The service must have its own `poii_data` and `poii_storage` volumes. Check in Docker that they are not the staging volumes before the first start.
4. **Service names on the shared network.** Staging and production run on the same server, and both Compose files name their services `db`, `api` and `web`. Whether `api` or `db` can resolve to the other environment's container over Dokploy's shared network has not been examined (`LIVE-ENVIRONMENT-FACTS.md`, 2026-11-25, last point). Check it before production holds data, for example that `getent hosts api` inside the production `web` container returns exactly one address, and that it is the production `api`. If it does not, stop: that needs a change to the Compose file (a gated change) first.
5. **Domains:** `poii.cetechbpa.com`, path `/`, service `web`, port `3000`, HTTPS; and the same host, path `/health`, service `api`, port `3001`, HTTPS, Strip Path disabled. As on staging, only the health endpoints of the API become public.
6. **HTTP/3** is already off for the whole server (`traefik.yml`, 2026-11-25). A new server or a Dokploy reinstall brings the default back; check that `curl -sI https://poii.cetechbpa.com/signin` shows no `Alt-Svc` header.
7. **API key.** Preferably a key of its own that can read and update the production service and create deployments. If Dokploy cannot scope a key that narrowly, the staging key also reaches production, and the compose id is all that separates the two; say so before using it.
8. **The compose id** of the production service (last segment of its page URL in the Dokploy panel).

### In GitHub

| Where | Name | Value |
|---|---|---|
| Repository variable | `POII_PRODUCTION_ENABLED` | `true` switches promotion on; anything else (or unset) keeps the workflow a no-op |
| `production` and `production-gated`, environment secret | `DOKPLOY_URL` | Dokploy panel origin, `https://…` |
| `production` and `production-gated`, environment secret | `DOKPLOY_TOKEN` | the Dokploy API key for production |
| `production` and `production-gated`, environment secret | `DOKPLOY_COMPOSE_ID` | the production Compose service id |
| `production` and `production-gated`, environment variable | `PRODUCTION_WEB_BASE_URL` | `https://poii.cetechbpa.com` (origin only, no path) |
| `production` and `production-gated`, environment variable | `PRODUCTION_API_BASE_URL` | optional; only if the API health is not routed on the web host |

- **`production` does not exist yet.** Create it: no required reviewers; Deployment branches and tags → **Selected branches and tags** with exactly one rule, `main`. Create it before the switch is set: GitHub creates a missing environment on first use, without any rule.
- **`production-gated` exists**, with the owner as required reviewer and a branch rule. On 2026-11-25 the agent read its branch rule as "protected branches only" (`protected_branches: true`). Change it to Selected branches and tags with exactly `main`, as was done for `staging`. Its secrets and variables are not readable by the agent.
- Both environments need the same four values. Environment secrets are per environment; there is no shared copy.
- The branch rule of each environment is what keeps the secrets away from other branches. The branch check inside the workflow is not a substitute (a workflow dispatched from another branch runs that branch's copy of the file).

The production hostname is not a secret. It appears in the logs and summaries of this public repository.

## First activation

The first production activation is a gated class of its own (release policy). In this order:

1. **Restore drill passed** on staging and recorded ([rollback-and-restore.md §3](rollback-and-restore.md#3-restore-drill-before-production-activation)). It has not been run yet.
2. Staging is shown green for the source to activate, and the Dokploy and GitHub setup above is complete.
3. **The owner's phrase** `POII PRODUCTION ACTIVATION APPROVED` is given in chat and recorded in `CURRENT-WORK.md` with its date.
4. **Dry run.** Actions → Deploy production → Run workflow on `main`, with the SHA staging serves and `dry_run` ticked; `POII_PRODUCTION_ENABLED` still unset. Let the agent start it (see "prevent self-review" above). The gate classifies it `gated` (first deploy). The owner approves the waiting `deploy` job. Expect a green run whose summary lists the current and target values of the three variables. Check on the run page that the job ran under `production-gated`. A compose id that names the staging service fails the run ("does not have the WEB_BASE_URL expected for this environment"). Nothing was changed.
5. **The owner sets** `POII_PRODUCTION_ENABLED=true`.
6. **First deploy.** Run the workflow again without `dry_run` (or wait for the next green staging deploy). It is gated: the owner approves it in `production-gated`. Expect the Dokploy deployment `done`, the SHA on `https://poii.cetechbpa.com/health/ready`, all smoke checks passed, and a manifest with `previous: null` and `promotionClass: gated`.
7. Sign in on production once and remove `POII_OWNER_BOOTSTRAP_PASSWORD` from the production environment afterwards (ADR-0009).
8. Record it (next section).

The `production` environment's own secrets are first used by the first routine promotion. If one is wrong, that run fails in the configuration check or while reading Dokploy, before anything is changed.

After the first activation, routine promotions go out without the owner; gated ones wait in `production-gated`.

## After a successful deploy

The workflow never pushes to `main`. The agent opens a normal PR that:

- adds the manifest from the run's summary or artifact as `infra/releases/<name>.json` (a gated path);
- adds the observation to `LIVE-ENVIRONMENT-FACTS.md`: time, both digests, the SHA reported by `/health/ready` on the production host, the promotion class, the run link;
- records the run in `CURRENT-WORK.md`.

## When it fails

Nothing is rolled back automatically. The summary says which step failed and, if the Dokploy environment had already been changed, the previous `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA`.

- **Gate:** nothing touched Dokploy. "Not a successful main run of Deploy staging", "no unexpired staging manifest" or a manifest that fails its checks mean there is no proof from staging: deploy the source to staging first. "The previous production deploy could not be looked up" is GitHub not answering: run again later.
- **Approval rejected or timed out:** nothing touched Dokploy. The next staging deploy, or a manual dispatch, starts a new promotion.
- **Configuration check:** a secret or the variable is missing in the environment the run used. Nothing touched Dokploy.
- **"Superseded":** not a failure. Production already runs that source or a later one.
- **Deploy-time check failed:** production changed between classification and deploy in a way that needs a new classification. Nothing touched Dokploy. Start a new run.
- **"Does not have the WEB_BASE_URL expected for this environment":** `DOKPLOY_COMPOSE_ID` names another service, or the production service's `WEB_BASE_URL` differs from `PRODUCTION_WEB_BASE_URL`. Nothing was changed. Correct the secret or the variable.
- **Digest verification:** the registry and the staging manifest disagree. Nothing touched Dokploy. Investigate before deploying anything.
- **Dokploy step, timeout, readiness or smoke:** as in [staging-deploy.md](staging-deploy.md#when-it-fails), but on production. After the environment update production may already run the new images. A timeout does not cancel the Dokploy deployment; never cancel a running migration. Decide whether to roll back.
- A failed run writes no manifest. The next promotion is classified from the last deploy that passed every check, so its range can only be longer, never shorter.

Logs of this public repository are public. The scripts print status codes, SHAs, image references, run ids, pull request numbers, risk labels and variable names only.

## Rolling back

The procedure is [rollback and restore §1](rollback-and-restore.md#1-roll-back-the-application-one-step): set the previous digest pair in Dokploy and redeploy. Never restore the database as part of an application rollback; that is §2 and needs the owner's go-ahead.

- The previous pair is in the failed run's summary, in the `previous` manifest named by the newest production manifest, and in `infra/releases/`.
- A rollback through the workflow is also possible while the older source's staging manifest still exists (90 days): run `Deploy production` by hand with that `source_sha`. It is always gated, because the running source is not an ancestor of the older one.
- **Set `POII_PRODUCTION_ENABLED` to something other than `true` first, and leave it off until the fix is merged.** Otherwise the next green staging deploy promotes `main` again, including the change that was rolled back. After a rollback done by hand in Dokploy the workflow still counts from its own last manifest.
- Expand/contract migrations (ADR-0003) let the previous application run against the newer schema.
