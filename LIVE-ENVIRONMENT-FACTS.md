# Live environment facts

Observed deployments only, by digest, with the time of observation. CI success is recorded in `CURRENT-WORK.md`, not here. Nothing in this file is a secret: hostnames, addresses, digests, run ids, models, list prices and caps only. Keys, tokens, Dokploy ids and backup credentials never belong here.

## 2026-11-25

### What staging serves

`https://poii-staging.cetechbpa.com` serves source `651c1eba6d2e96b1340db18bd59e5a7b16a1d2a8` (PR #59) since 2026-11-24 18:25 UTC. No production deployment exists.

| Slot | Value |
| --- | --- |
| Staging deploy: date and time (UTC) | 2026-11-24 18:25:56 (`deployedAt` in the manifest) |
| Staging deploy: `Deploy staging` run link and attempt | [run 45459328981](https://github.com/WB-DevWorld/POII/actions/runs/45459328981), attempt 1, started by [publish run 45458952082](https://github.com/WB-DevWorld/POII/actions/runs/45458952082) |
| Staging deploy: source SHA and both digests actually deployed | `651c1eba6d2e96b1340db18bd59e5a7b16a1d2a8`; API `ghcr.io/wb-devworld/poii-api@sha256:b14452a84cb4c3c80cd0e5ff0b9ff933fc145e25479c8e84af7c2b3b5549f60b`; web `ghcr.io/wb-devworld/poii-web@sha256:9ad7c03e36445c294593fc2ea823d7aed1b951b0156fe582545ff23297d885ef` |
| Staging deploy: `version` reported by `GET /health/ready` on the staging host | `651c1eba6d2e96b1340db18bd59e5a7b16a1d2a8`, `status: ready`, `aiEnabled: true` (the workflow's wait step; the bot again on 2026-11-25 at 13:15 UTC) |
| Staging deploy: release manifest file name under `infra/releases/` | `staging-20261124T182556Z-651c1eba6d2e.json` (`previous`: `staging-20261124T180747Z-656f2faaa551.json`) |
| Staging deploy: `GET /health/version` → `migrations.applied` / `migrations.latest` | `0005_accesslobby_identity_link` / `0005_accesslobby_identity_link` (2026-11-25 13:15 UTC); `node` `v24.22.3`, `builtAt` `null` |
| Backup: first scheduled run on staging (`GET /health/version` → `backup.lastRunAt`, `lastTarget`, `lastStatus`) | pending. `backup` is `null` on 2026-11-25 at 13:15 UTC; no backup target is configured yet |
| Restore drill: date, source backup object key, duration, outcome (`docs/runbooks/backup-and-restore-drill.md` §6) | pending |
| First real call, Anthropic `claude-opus-5-5`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | 2026-11-25, see "First real AI call" below: 5 candidates, 1,494 input / 2,822 output tokens, USD 0.0624, USD 19.94 remaining of 20.00. The `outcome` field was not read by name |
| First real call, OpenAI `gpt-6.1-sol`: date, `outcome`, candidates, input / output tokens, cost USD, `remainingUsd` after | pending. The owner reports that the OpenAI account still has no API credit |
| Compatibility matrix rows completed (`docs/compatibility-matrix.md`, "Waiting for staging") | the web sign-in row and the Anthropic row moved to "Tested" today; the OpenAI row is still pending |

### First signed-in session on staging

The owner's own browser session on the staging host, 2026-11-25 at about 10:23 UTC, Chrome 157.0.8103.80 (64-bit), reported by the owner step by step. The source text was `fixtures/decision-chain.md`, copied from a rendered Markdown view (1,456 characters, so without the Markdown markers). The owner had already reported a working sign-in on 2026-11-24 at about 19:30 UTC.

| Step | Result |
| --- | --- |
| Sign in as the owner on `/signin` | worked |
| Add a source by pasting text | worked |
| Mark a passage and create one candidate by hand | worked |
| Confirm the candidate | worked |
| Search for a word from the passage | worked: the hit was listed |
| Open the evidence from the search hit (source page at the exact passage) | **kept loading and never finished** at about 10:23 UTC. Loaded on a retry later the same day |
| Open Current decisions (`/decisions`) | **never loaded** at about 10:23 UTC. Loaded on a retry later the same day |

Not exercised on staging in this session: superseding a record, the other views, export, backup and restore, owner tokens.

### The two pages that kept loading

- No deploy ran between the failing attempt and the retry; staging served `651c1eba6d2e96b1340db18bd59e5a7b16a1d2a8` throughout. The last `Deploy staging` run before the session ended on 2026-11-24 at 18:26 UTC.
- The same journey on a local copy of `651c1eba6d2e96b1340db18bd59e5a7b16a1d2a8` with the same pasted text did not show it: the API alone answered every call in 20 to 170 ms; the web app under `next start` and under the standalone `server.js` rendered both pages in 40 to 60 ms; a Chromium browser clicked from the search hit to the evidence page and opened Current decisions in 120 to 270 ms with no console error.
- The cause is not known. Nothing was read from the staging containers' logs for that minute.
- What the reading of the code did show: the web app's calls to the API and the API's database pool had no time limit, so one stuck call shows as a page that loads for minutes and leaves no trace. PR #77 adds limits and a request id to follow (open when this was written).
- `compose.dokploy.yaml` asks for Isolated Deployment to stay off in Dokploy, so the service names `api`, `web` and `db` are resolved on a network shared with other Compose services on that server. Whether that played a part is not known; it has not been examined.

### First real AI call

The first provider call from a POII instance: the owner on staging, 2026-11-25 shortly after 10:23 UTC, through "AI-assisted extraction" on the source above. Values as shown by the web interface (owner's screenshots); `GET /v1/ai/usage` was not called directly.

| Item | Value |
| --- | --- |
| Provider and model | Anthropic, `claude-opus-5-5` |
| Caps before | Anthropic: spent USD 0.00, reserved USD 0.00, remaining USD 20.00 of 20.00. OpenAI: the same |
| Preview | characters 0 to 1,456 of the source; prompt 2,697 characters, SHA-256 `b2f89393b2882b3f97adbc7a0f1ddab2c65e080dff37961600c378b8de62e894`; estimate USD 0.1652 (about 1,300 input and at most 8,000 output tokens); preview valid until 10:44 UTC |
| Result | 5 candidates: 2 decisions, 2 facts, 1 requirement. All `candidate` and `ai_extracted`; nothing confirmed |
| Usage reported by the provider | 1,494 input and 2,822 output tokens |
| Cost | USD 0.0624. At list price: 1,494 × 4 / 1,000,000 + 2,822 × 20 / 1,000,000 = USD 0.062416 |
| Caps after | Anthropic: spent USD 0.0624, remaining USD 19.94 of 20.00 |
| Reopening the used preview | answers `preview_used`; nothing is sent twice |

Not observed: the execution's `outcome` field by name, and the audit event. The OpenAI provider was not tried.

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

The rows marked `pending` here are carried forward, filled or still `pending`, in the table under 2026-11-25 above.

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
