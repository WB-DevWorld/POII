# Staging deploy

How `.github/workflows/deploy-staging.yml` puts a published digest on staging (release policy steps 1–3), what the owner has to set up first, and what to do when it fails. Decisions behind it: [ADR-0010](../adr/0010-staging-deploy-mechanics.md).

**Status: written, never run.** No Dokploy project, token, compose service or staging hostname exists yet. Nothing in this runbook has been tried against Dokploy; the Dokploy calls are based on its documentation and source code as read on 2026-10-10 (see [Dokploy API used](#dokploy-api-used)). The scripts were only exercised against local mock servers.

## What happens on merge

Nothing. The workflow starts after every successful `Publish immutable images` run on `main`, but its first job stops with a step summary saying staging deploys are switched off, until the **repository variable** `POII_STAGING_ENABLED` is `true`. The `deploy` job, which is the only job that uses the `staging` environment and its secrets, is skipped. No Dokploy request is made. The only exception is a manual dispatch with `dry_run`, which reads Dokploy and changes nothing.

## What one run does

1. **Gate** (no secrets). Checks `POII_STAGING_ENABLED`. Finds the release to deploy:
   - after a publish run: the run's single unexpired artifact `poii-release-<sha>`. If the publish run has none (its images job was skipped), the run ends as a no-op.
   - manual dispatch from `main` with `source_sha` (40 lowercase hex): the newest unexpired artifact of that name. Artifacts are kept 90 days; older SHAs cannot be redeployed this way (use the rollback runbook instead).
   - Either way the producing run must be a successful `main` run of `.github/workflows/publish.yml` in this repository.
2. **Deploy job** in the `staging` environment, concurrency group `deploy-staging`, `cancel-in-progress: false`: one deploy at a time. A newer run waiting for the group replaces an older one that is still waiting (GitHub keeps one pending run); a running deploy is never cancelled.
3. Checks the secrets and variables exist (names only; values are never printed).
4. Downloads the artifact, parses `release.txt`, requires `Source:` to equal the SHA and both image references to match `ghcr.io/wb-devworld/poii-{api,web}@sha256:<64 hex>`. Cross-checks that the GHCR tags `sha-<sha>` currently point at the same digests (`docker buildx imagetools inspect`, logged in with the job's `GITHUB_TOKEN`, `packages: read`). A mismatch fails the run.
5. `infra/scripts/dokploy-deploy.mjs`:
   1. reads the Compose service (`compose.one`) and masks every value of its environment except the three it manages;
   2. replaces exactly `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA` in the environment, keeping every other line byte for byte (a managed key defined twice stops the run; a missing one is appended);
   3. writes it back (`compose.update`), reads the service again and requires `env` to be stored exactly as sent and every other field (except timestamps and status) to be unchanged;
   4. starts a deployment (`compose.deploy`) with a unique title `POII staging <sha> run <run id>.<attempt>`;
   5. polls `deployment.allByCompose` for the new deployment with that title (or, with a warning, the single new deployment if Dokploy did not keep the title) until it is `done` (success), `error` or `cancelled` (failure), with a 20-minute limit. On timeout it fails **without cancelling** anything in Dokploy: a running migration is never cancelled.
   The previous `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA` are printed and kept as step outputs for the failure summary.
6. `staging-smoke.sh wait`: polls `GET <API health base>/health/ready` every 10 s until it answers 200 with `status: ready` and `version` equal to the SHA; hard limit 10 minutes.
7. `staging-smoke.sh check`: `/health/live` 200 `ok` with the SHA, `/health/ready` 200 `ready` with the SHA, the web root answers 200, an unknown path answers 404. The Playwright core-journey smoke is **skipped with a printed reason**: no sign-in method is approved for staging yet (local-owner is loopback-only unless `POII_ALLOW_LOCAL_OWNER_REMOTE` is set deliberately; local sign-in is #14). The hook is `run_core_journey_smoke` in the script, switched by the staging variable `POII_STAGING_E2E_AUTH`; setting it today fails the smoke on purpose, because `apps/web/playwright.config.ts` can only start local servers.
8. Writes the release manifest (format in `infra/releases/README.md`) to the step summary and as the artifact `poii-staging-manifest-<sha>-<attempt>` (kept 90 days). The file name is `staging-<UTC yyyymmddThhmmssZ>-<sha12>.json`; `previous` is the newest `infra/releases/staging-*.json` on `main` at run time, or `null`.

Production promotion is not in this workflow. Permissions: `contents: read`, `packages: read`, `actions: read`.

**Dry run.** A manual dispatch with `dry_run: true` reads the Compose service and its deployments, validates the token, the compose id and the response shapes, and prints which of the three variables would change. It changes nothing and skips steps 6–8. It is allowed while `POII_STAGING_ENABLED` is off. Use it first.

## Owner setup (before switching it on)

These extend [owner setup §5](owner-setup.md#5-dokploy-on-the-existing-hetzner-capacity).

### In Dokploy

1. **Compose service** for staging from `compose.dokploy.yaml`, Isolated Deployment off, source = this repository, branch `main`. Turn **Autodeploy off** (otherwise every push to `main` would also redeploy staging outside this workflow, with whatever images the environment names). The script warns if it sees autodeploy on.
2. **Environment** of the Compose service: `POSTGRES_PASSWORD`, `POII_SESSION_SECRET`, `WEB_BASE_URL=https://<staging host>`, and initial `API_IMAGE`, `WEB_IMAGE`, `GIT_SHA` (any published pair, e.g. from the latest publish run summary). The workflow only ever changes those last three.
3. **Domains** (Compose service → Domains):
   - `<staging host>`, path `/`, service `web`, container port `3000`, HTTPS (Let's Encrypt).
   - `<staging host>`, path `/health`, service `api`, container port `3001`, HTTPS, **Strip Path: disabled** (the API expects the `/health` prefix). Dokploy turns this into the Traefik rule ``Host(`<staging host>`) && PathPrefix(`/health`)``, which outranks the plain host rule because Traefik prefers longer rules. Only the API's `/health/live` and `/health/ready` become reachable from outside; the rest of the API stays internal. The web app has no `/health` route, so nothing is shadowed.
   - Alternative, not recommended: a separate API hostname with path `/`. It would publish the whole API, which today has no authentication of its own. If chosen anyway, set the staging variable `STAGING_API_BASE_URL` to that origin.
4. **API key** (profile → API/CLI). Generate it as a Dokploy member that can only see the POII project and may read and update the Compose service and create deployments. Which permissions Dokploy actually checks, and whose rights a key carries, are listed with their sources and confidence under [Dokploy API used](#dokploy-api-used); confirm them when the key is created. If the member permissions cannot be narrowed that far on this installation, say so before using an admin key.
5. **GHCR pull credentials** as in owner setup §5.4.
6. **The compose id**: open the staging Compose service in the Dokploy panel; the id is the last segment of the page URL (or `composeId` in `GET /api/project.all`).

**Blocker to resolve first.** With a non-loopback `WEB_BASE_URL` the API refuses to start under the local-owner identity unless `POII_ALLOW_LOCAL_OWNER_REMOTE=true` (ADR-0004, `apps/api/src/adapters/local-owner.identity.ts`). Until local sign-in (#14) ships, a staging deploy therefore either never becomes ready (step 6 times out) or, with that flag set, exposes an unauthenticated owner workspace on a public hostname. That is the owner's decision; see the open question in the PR.

### In GitHub (Settings → Secrets and variables, and Settings → Environments → `staging`)

| Where | Name | Value |
|---|---|---|
| Repository variable | `POII_STAGING_ENABLED` | `true` to switch deploys on; anything else (or unset) keeps the workflow a no-op |
| `staging` environment secret | `DOKPLOY_URL` | Dokploy panel origin, `https://…` (a trailing `/api` is accepted). Plain `http` is refused. |
| `staging` environment secret | `DOKPLOY_TOKEN` | the Dokploy API key |
| `staging` environment secret | `DOKPLOY_COMPOSE_ID` | the staging Compose service id |
| `staging` environment variable | `STAGING_WEB_BASE_URL` | `https://<staging host>` (origin only, no path) |
| `staging` environment variable | `STAGING_API_BASE_URL` | optional; only if the API health is not routed on the web host |
| `staging` environment variable | `POII_STAGING_E2E_AUTH` | leave unset until a staging sign-in method is approved |

The staging hostname is not a secret: it appears in the logs and summary of this public repository the first time the workflow runs (environment URL, smoke output).

### First switch-on

1. **Prerequisite: lock the `staging` environment to `main`.** Settings → Environments → `staging` → Deployment branches and tags → **Selected branches and tags**, with exactly one rule, `main`. No required reviewers (staging deploys are automatic). This is what keeps the Dokploy secrets away from other branches. The branch check inside the workflow is not a substitute: a workflow dispatched from another branch runs that branch's copy of the file, which could drop the check.
2. Set the secrets and variables above, leave `POII_STAGING_ENABLED` unset.
3. Actions → Deploy staging → Run workflow on `main` with the latest published SHA and `dry_run` ticked. Expect a green run whose summary lists the current and target values of the three variables. Confirm on the run page that the `deploy` job ran under the `staging` environment (it is listed as a deployment to `staging`); if it did not, the secrets were not available and the branch rule needs checking.
4. Set `POII_STAGING_ENABLED=true`, then either run it again without `dry_run` or wait for the next published `main` commit. From then on every published `main` commit deploys to staging.

## After a successful deploy

The workflow never pushes to `main` (the ruleset forbids it). The agent then opens a normal PR that:

- adds the manifest from the run's summary or artifact as `infra/releases/<name>.json` (a gated path: waits for the owner's approval phrase);
- adds the observation to `LIVE-ENVIRONMENT-FACTS.md`: time, environment, both digests, the SHA reported by `/health/ready`, and the run link;
- records the run in `CURRENT-WORK.md`.

## When it fails

Nothing is rolled back automatically. The run's summary says which step failed and, if the Dokploy environment had already been changed, the previous `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA` (the one-step rollback target).

- **Gate or configuration step:** nothing touched Dokploy. Fix the variable, secret or artifact and rerun.
- **Digest verification:** nothing touched Dokploy. A tag/artifact mismatch means the registry and the publish record disagree; investigate before deploying anything.
- **Dokploy step:** read the message (HTTP status and Dokploy's error code; bodies are never printed). An "unexpected shape" or "did not store the environment exactly" error means Dokploy's API differs from what this runbook assumes: stop and compare with the references below. A deployment `error` means `docker compose up` failed; read the deployment log in Dokploy.
- **Timeout:** the Dokploy deployment was not cancelled and may still finish, including a migration. Watch it in Dokploy; do not cancel a running migration.
- **Readiness or smoke:** the new containers run but do not report the SHA or fail a check. Decide whether to roll back with [rollback and restore §1](rollback-and-restore.md#1-roll-back-the-application-one-step). Never restore the database as part of an application rollback.

Logs of this public repository are public. The scripts print status codes, SHAs, image references and variable names only; every value of the Dokploy environment other than the three managed ones is masked before any request that could echo it.

## Dokploy API used

All read on 2026-10-10. Base: `<DOKPLOY_URL>/api/<router>.<procedure>`; queries are `GET` with query-string input, mutations `POST` with a JSON body; authentication is the header `x-api-key: <token>`.

| Call | Used for | Source | Confidence |
|---|---|---|---|
| header `x-api-key`, base `/api` | authentication | [docs.dokploy.com/docs/api](https://docs.dokploy.com/docs/api) | high (documented with an example) |
| `GET /api/compose.one?composeId=` | read the environment (`env`), `sourceType`, flags | [API reference: compose](https://docs.dokploy.com/docs/api/reference-compose); router source [compose.ts](https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/compose.ts) | medium: the docs show the response only as `{}`; the source returns the stored compose row, which has an `env` text column |
| `POST /api/compose.update` `{composeId, env}` | write the environment | same docs page; [services/compose.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/compose.ts) `updateCompose` | medium-high: the source sets the given columns, so `env` replaces the whole stored string (hence the script sends the full rewritten string and reads it back) |
| `POST /api/compose.deploy` `{composeId, title}` | start a deployment | same docs page and router source | high on the request; the router queues the job and returns `{success: true, message, composeId}` (self-hosted) or `true` (Dokploy Cloud); both are accepted |
| `GET /api/deployment.allByCompose?composeId=` | find our deployment and its status | [API reference: deployment](https://docs.dokploy.com/docs/api/reference-deployment); schema [deployment.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/deployment.ts) | medium: the docs show `{}`; the schema has `deploymentId`, `title`, `status` (`running`, `done`, `error`, `cancelled`), `createdAt`, `errorMessage` |
| Domains with a path | route `/health` to the API | [utils/docker/domain.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/domain.ts) builds ``Host(…) && PathPrefix(`<path>`)``; [API reference: domain](https://docs.dokploy.com/docs/api/reference-domain) lists `path`, `stripPath`, `serviceName`, `port` | medium-high (source, not prose docs) |
| deploy runs `docker compose … up -d --build --remove-orphans` after writing `.env` beside the compose file | why changing `env` and deploying is enough | [utils/builders/compose.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/builders/compose.ts) | medium-high (source) |
| permission checks | what the key's member needs | router source [compose.ts](https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/compose.ts): `compose.one` checks service access `read`; `compose.update` checks `service: create`; `compose.deploy` checks `deployment: create` | medium (`canary` source, not docs; the installed version may differ). The check for `deployment.allByCompose` was not read: **unverified; confirm when the key is created** |
| whose rights a key carries | scoping the key | [docs.dokploy.com/docs/api](https://docs.dokploy.com/docs/api): keys are generated per user profile; that a key acts with exactly that user's project access is inferred, not stated | **unverified; confirm when the key is created** (a dry run with the member's key shows it) |

**Not clear from the documentation, handled by failing loudly:**

- Response bodies are undocumented (`{}` in the reference). The script checks every field it uses (`composeId` matches, `env` is a string or null, the deployment list is an array of objects with string `deploymentId` and `status`) and stops otherwise.
- Whether `compose.update` stores `env` verbatim (line endings, trailing newline) and touches nothing else. The script reads the service back and stops before deploying if `env` differs from what it sent, or if any other field differs from before the update ("compose.update changed fields other than env"); timestamps and status fields are ignored because they move on their own.
- How deployments are ordered in `deployment.allByCompose`, and whether the `title` sent to `compose.deploy` is stored. The script does not rely on order; it matches its own unique title among deployments that did not exist before the call. If no new deployment carries the title but exactly one new deployment appeared, it tracks that one with a warning ("Dokploy did not echo our title"); more than one new deployment without a match stops the run. A timeout reports how many new deployments were seen.
- Unknown deployment statuses stop the run instead of being treated as success.
- `compose.deploy` re-fetches the configured Git source before `compose up`; `compose.redeploy` would not. `deploy` is used so a merged change to `compose.dokploy.yaml` reaches staging. The compose file therefore comes from the head of the configured branch at deploy time, not necessarily the exact source SHA; the window is small because compose changes are gated and deploys run one at a time.
- The Dokploy source was read on its `canary` branch; the installed version may differ. Check with a dry run after any Dokploy upgrade.
