# Live environment facts

Observed deployments only, by digest, with the time of observation. CI success is recorded in `CURRENT-WORK.md`, not here. Nothing in this file is a secret: hostnames, addresses, digests, run ids, models, list prices and caps only. Keys, tokens, Dokploy ids and backup credentials never belong here.

## 2026-11-24

### First staging deployment

Staging runs. `https://poii-staging.cetechbpa.com` serves source `656f2faaa551c8101ed51949ad37ff6631227d98` (PR #76) since 18:07 UTC. No production deployment exists.

| Slot | Value |
| --- | --- |
| Staging deploy: date and time (UTC) | 2026-11-24 18:07:47 (`deployedAt` in the manifest) |
| Staging deploy: `Deploy staging` run link and attempt | [run 45455991242](https://github.com/WB-DevWorld/POII/actions/runs/45455991242), attempt 1, started by [publish run 45455590292](https://github.com/WB-DevWorld/POII/actions/runs/45455590292) |
| Staging deploy: source SHA and both digests actually deployed | `656f2faaa551c8101ed51949ad37ff6631227d98`; API `ghcr.io/wb-devworld/poii-api@sha256:2ce693e1a4222dcd94c9af5f98a6a668659e91922769b4858a15448836a7e9fd`; web `ghcr.io/wb-devworld/poii-web@sha256:d36aa57eb2aaeeed29e0ccfd05fff2efbc78d63b1ec398a667b0c28f874f6c0d` |
| Staging deploy: `version` reported by `GET /health/ready` on the staging host | `656f2faaa551c8101ed51949ad37ff6631227d98`, `status: ready`, `aiEnabled: true` (the workflow's wait step, and the bot at 18:09 UTC) |
| Staging deploy: release manifest file name under `infra/releases/` | `staging-20261124T180747Z-656f2faaa551.json` (first manifest, `previous: null`) |
| Staging deploy: `GET /health/version` → `migrations.applied` / `migrations.latest` | `0005_accesslobby_identity_link` / `0005_accesslobby_identity_link` (18:09 UTC); `node` `v24.22.3`, `builtAt` `null` |
| Backup: first scheduled run on staging (`GET /health/version` → `backup.lastRunAt`, `lastTarget`, `lastStatus`) | pending. `backup` is `null` at 18:09 UTC; no backup target is configured yet |
| Restore drill: date, source backup object key, duration, outcome (`docs/runbooks/backup-and-restore-drill.md` §6) | pending |
| First real call, Anthropic `claude-opus-5-5`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | pending |
| First real call, OpenAI `gpt-6.1-sol`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | pending |
| Compatibility matrix rows completed (`docs/compatibility-matrix.md`, "Waiting for staging") | the staging HTTP API row is completed; the web sign-in row and both provider rows are still pending |

### What was observed on the way there

- DNS at about 17:50 UTC through 1.1.1.1 and 8.8.8.8: `poii-staging.cetechbpa.com` and `poii.cetechbpa.com` are A records to `49.13.152.39`, no AAAA.
- The `staging` environment now has the deployment-branch rule the runbook asks for (`custom_branch_policies: true`, one policy `branch:main`). Its secrets and variables are not readable by the bot; the dry run below proved they are present.
- At about 17:50 UTC, before any workflow deploy, `GET /health/ready` on the staging host already answered `version` `f71113d9096b941cf4eef85a15da6623e964dad2`: the owner had started the Compose service from the Dokploy interface with the images of 2026-10-12. The workflow deploys below replaced it within the hour.
- Dry run: [run 45453269972](https://github.com/WB-DevWorld/POII/actions/runs/45453269972), success. Dokploy was only read ("the token, compose id and response shapes are valid").
- The repository variable `POII_STAGING_ENABLED` was then set to `true`. From here every successful publish run on `main` deploys to staging.
- First workflow deploy: [run 45453522584](https://github.com/WB-DevWorld/POII/actions/runs/45453522584) for `e4cfa470dfb67b0a5df6c8c488a1e0638ed8a8ce`. Dokploy deployed it and `/health/ready` reported it, but the smoke step failed (web root and unknown route answer 307 to `/signin` under local sign-in; the script expected 200 and 404), so that run wrote no manifest. PR #76 corrected the script.
- Second workflow deploy: run 45455991242 above, after PR #76 merged. All smoke checks passed; the Playwright core-journey smoke was skipped with its printed reason.
- Signed out, at 18:09 UTC: `/` answers 307 to `/signin`; `/signin` answers 200; an unknown path and `/v1/sources` answer 307 to `/signin?next=…`; `/health/live` answers 200. HTTPS carries a publicly trusted certificate (the smoke step's `curl` on the GitHub runner verified it).
- Not observed yet: a person signing in on staging, a backup run, a restore drill, any AI call from a POII instance.

### Images published today

| Source commit | Publish run | Note |
| --- | --- | --- |
| `a30333353372eed81bb8426ec4ecc44043b17d8a` (PR #74, dependency security updates) | [45437755990](https://github.com/WB-DevWorld/POII/actions/runs/45437755990) | first images with Next.js 16.4.5 |
| `efe2e0453d85214a33a3db9808da4c3d8f6522fb` (PR #72) | none | merged by auto-merge, so no CI and no publish run started; PR #75 added `main-ci-catchup.yml` for this case |
| `1f2043f6525a99455a90927417546d6d80d50ec7` (PR #75) | [45450340065](https://github.com/WB-DevWorld/POII/actions/runs/45450340065) | |
| `e4cfa470dfb67b0a5df6c8c488a1e0638ed8a8ce` (PR #73) | [45451024925](https://github.com/WB-DevWorld/POII/actions/runs/45451024925), attempt 2 | attempt 1 failed with `429 Too Many Requests` from `public.ecr.aws` while pulling the Node base image |
| `656f2faaa551c8101ed51949ad37ff6631227d98` (PR #76) | [45455590292](https://github.com/WB-DevWorld/POII/actions/runs/45455590292) | deployed, see above |

### AI providers

- Configuration is unchanged from the 2026-10-26 table below. No POII instance has called a provider yet.
- The owner replaced the Anthropic key with one that belongs to a workspace. Outside POII, the bot sent one single-token request to `POST https://api.anthropic.com/v1/messages` with it from the owner's machine at about 14:00 UTC: HTTP 200, usage 10 input and 1 output tokens. The key value is recorded nowhere.
- The owner reports that the OpenAI account still has no API credit.

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

The slots this section left open are filled, or still marked `pending`, under 2026-11-24 above.

## 2026-10-10

- No staging or production deployment exists. No Dokploy project, backup target or AccessLobby client registration exists for POII yet.
- Immutable images were published for every merge to `main` observed today: [run 38017613639](https://github.com/WB-DevWorld/POII/actions/runs/38017613639) for `74af208e24edbb5cdca5ae5d62e2e7f888365b2e` (PR #26), [run 38018859427](https://github.com/WB-DevWorld/POII/actions/runs/38018859427) for `ee295683f54912d76c0d68f7f1168a603840e727` (PR #27), [run 38019515122](https://github.com/WB-DevWorld/POII/actions/runs/38019515122) for `5b4459292b91fc87edeb90386bd7d7723ad7225c` (PR #29). Tags `ghcr.io/wb-devworld/poii-api:sha-<sha>` and `poii-web:sha-<sha>`; digests in each run summary. No publish run exists for `96119b1` (PR #28). The packages stay private on GHCR.
- The GitHub App `wbdevworld-poii-agent` is installed on this repository (installation 169805354); agent commits and PRs are authored by it from today.

## 2026-10-09

- No staging or production deployment exists.
- First immutable images were published by [publish run 37996328909](https://github.com/WB-DevWorld/POII/actions/runs/37996328909) for source `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02` (PR #10 merge): `ghcr.io/wb-devworld/poii-api:sha-df73e83…` and `ghcr.io/wb-devworld/poii-web:sha-df73e83…`. The digests are in that run's summary. The packages are private on GHCR (organization default); reading them needs `read:packages`, so the agent could not inspect the manifests from this machine. Dokploy will need the GHCR pull credentials from the owner setup list.
- `WB-DevWorld/POII` is public. It was empty (no branches) until the M0 seed commit on 2026-10-09.
- No backup target, Dokploy project or AccessLobby client registration exists for POII yet.
