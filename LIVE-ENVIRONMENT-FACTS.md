# Live environment facts

Observed deployments only, by digest, with the time of observation. CI success is recorded in `CURRENT-WORK.md`, not here. Nothing in this file is a secret: hostnames, addresses, digests, run ids, models, list prices and caps only. Keys, tokens, Dokploy ids and backup credentials never belong here.

## 2026-10-26

### Still no deployment

- No staging or production deployment exists. Nothing has been deployed to Dokploy, no backup has run against the S3 target, no live AI provider call has been made from any POII instance, and no AccessLobby client registration exists.
- `Deploy staging` has run three times, each after a publish run on 2026-10-12, and each time stopped in its gate job as a no-op because the repository variable `POII_STAGING_ENABLED` is not `true`: [38228254241](https://github.com/WB-DevWorld/POII/actions/runs/38228254241), [38229804301](https://github.com/WB-DevWorld/POII/actions/runs/38229804301), [38230444000](https://github.com/WB-DevWorld/POII/actions/runs/38230444000) (job `gate` success, job `deploy` skipped). No Dokploy request was made.
- The GitHub environments `staging` and `production-gated` exist. On 2026-10-26 the bot could read that `staging` has a deployment-branch rule of the kind "protected branches only" (`protected_branches: true`, `custom_branch_policies: false`); `docs/runbooks/staging-deploy.md` asks for "Selected branches and tags" with exactly `main`, which is a different setting. The environment's secrets and variables are not readable by the bot and are not confirmed.

### Targets (planned, not yet observed live)

| Item | Value | Observed on 2026-10-26 |
| --- | --- | --- |
| Staging URL | `https://poii-staging.cetechbpa.com` | DNS-only A record `49.13.152.39`, no AAAA (checked through 1.1.1.1 and 8.8.8.8). The host answers HTTP with 404 and HTTPS with an untrusted default certificate: Traefik is up, no POII domain is configured on it yet. |
| Staging host | Hetzner, Nuremberg, `49.13.152.39` (reverse name `static.39.152.13.49.clients.your-server.de`); Dokploy will run `compose.dokploy.yaml` there | Dokploy project, Compose service and domains not yet created by the owner (`docs/runbooks/owner-setup.md` §5). |
| Production URL | `https://poii.cetechbpa.com`, reserved; unused until the first production activation (`POII PRODUCTION ACTIVATION APPROVED`) | DNS-only A record `49.13.152.39`, no AAAA, same host as staging; same HTTP 404 and untrusted default certificate. Resolvers that cached the records from before the owner's switch to DNS-only may still show Cloudflare addresses for a while. |
| API from outside | only `/health/live`, `/health/ready` and `/health/version` on the staging host (ADR-0010 routes the `/health` prefix to the API); the rest of the API stays internal | not reachable yet |

### Release candidate for the first staging deploy

Newest published immutable images, read on 2026-10-26 from the `release.txt` inside the publish run's artifact `poii-release-f71113d9096b941cf4eef85a15da6623e964dad2` ([run 38230228578](https://github.com/WB-DevWorld/POII/actions/runs/38230228578), 2026-10-12 09:29 UTC, job `images` success):

| | |
| --- | --- |
| Source commit | `f71113d9096b941cf4eef85a15da6623e964dad2` (`docs: ledger records the #47 merge (#52)`) |
| API image | `ghcr.io/wb-devworld/poii-api@sha256:152d7ac3bf77f20ca3472d9f49f0c9325aeea3976e07f71b55c3614bbddccefb` |
| Web image | `ghcr.io/wb-devworld/poii-web@sha256:216e555bec9cb4bb53cc920276b7f06fb315b696a07c950662367b1d280a3ebb` |
| CI on that commit | `verify` success, [run 38229829580](https://github.com/WB-DevWorld/POII/actions/runs/38229829580) |

`main` has moved one commit further, to `7dff76389bf93cadae88b7c02c566b6636c46632` (PR #53, merged 2026-10-13 13:23 UTC). No `CI` and no `Publish immutable images` run exists for that commit (only scheduled CodeQL and Dependabot runs), so it has no images and cannot be deployed by digest. Either the publish workflow is run for it by hand or the first deploy uses `f71113d` above. The packages stay private on GHCR; Dokploy needs the pull credentials from the owner setup list.

### AI providers (configuration, not calls)

Defaults in `apps/api/src/config.ts` and list prices in `apps/api/src/ai/pricing.ts` (prices read from the provider pages on 2026-10-10). Caps are enforced inside POII per provider per calendar month (UTC), on top of the providers' own limits.

| Provider | Model | List price, USD per MTok (in / out) | Monthly cap | Endpoint |
| --- | --- | --- | --- | --- |
| Anthropic | `claude-opus-5-5` | 4 / 20 | USD 20 | `POST https://api.anthropic.com/v1/messages`, HTTPS JSON |
| OpenAI | `gpt-6.1-sol` | 2 / 10 (2x / 1.5x above 272,000 input tokens) | USD 20 | `POST https://api.openai.com/v1/responses`, HTTPS JSON |

- Owner's local instance, 2026-10-26: `GET /health/ready` on loopback answered `{ "status": "ready", "version": "dev", "aiEnabled": true }`; the instance runs the `local-signin` adapter (`GET /v1/ai/status` without a session is `401 unauthenticated`). The integrating session reports both providers as configured with keys on that instance; the bot did not see the status body and no key value is recorded anywhere.
- No provider has been called yet from any POII instance. Every provider response in the test suite is a hand-written MOCKED file (`apps/api/test/recorded/`).

### To be filled by the first deploy and the first real calls

Fill each slot from an observation you made, with its time (UTC) and a link; leave it `pending` otherwise.

| Slot | Value |
| --- | --- |
| Staging deploy: date and time (UTC) | pending |
| Staging deploy: `Deploy staging` run link and attempt | pending |
| Staging deploy: source SHA and both digests actually deployed | pending |
| Staging deploy: `version` reported by `GET /health/ready` on the staging host | pending |
| Staging deploy: release manifest file name under `infra/releases/` | pending |
| Staging deploy: `GET /health/version` → `migrations.applied` / `migrations.latest` | pending |
| Backup: first scheduled run on staging (`GET /health/version` → `backup.lastRunAt`, `lastTarget`, `lastStatus`) | pending |
| Restore drill: date, source backup object key, duration, outcome (`docs/runbooks/backup-and-restore-drill.md` §6) | pending |
| First real call, Anthropic `claude-opus-5-5`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | pending |
| First real call, OpenAI `gpt-6.1-sol`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | pending |
| Compatibility matrix rows completed (`docs/compatibility-matrix.md`, "Waiting for staging") | pending |

## 2026-10-10

- No staging or production deployment exists. No Dokploy project, backup target or AccessLobby client registration exists for POII yet.
- Immutable images were published for every merge to `main` observed today: [run 38017613639](https://github.com/WB-DevWorld/POII/actions/runs/38017613639) for `74af208e24edbb5cdca5ae5d62e2e7f888365b2e` (PR #26), [run 38018859427](https://github.com/WB-DevWorld/POII/actions/runs/38018859427) for `ee295683f54912d76c0d68f7f1168a603840e727` (PR #27), [run 38019515122](https://github.com/WB-DevWorld/POII/actions/runs/38019515122) for `5b4459292b91fc87edeb90386bd7d7723ad7225c` (PR #29). Tags `ghcr.io/wb-devworld/poii-api:sha-<sha>` and `poii-web:sha-<sha>`; digests in each run summary. No publish run exists for `96119b1` (PR #28). The packages stay private on GHCR.
- The GitHub App `wbdevworld-poii-agent` is installed on this repository (installation 169805354); agent commits and PRs are authored by it from today.

## 2026-10-09

- No staging or production deployment exists.
- First immutable images were published by [publish run 37996328909](https://github.com/WB-DevWorld/POII/actions/runs/37996328909) for source `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02` (PR #10 merge): `ghcr.io/wb-devworld/poii-api:sha-df73e83…` and `ghcr.io/wb-devworld/poii-web:sha-df73e83…`. The digests are in that run's summary. The packages are private on GHCR (organization default); reading them needs `read:packages`, so the agent could not inspect the manifests from this machine. Dokploy will need the GHCR pull credentials from the owner setup list.
- `WB-DevWorld/POII` is public. It was empty (no branches) until the M0 seed commit on 2026-10-09.
- No backup target, Dokploy project or AccessLobby client registration exists for POII yet.
