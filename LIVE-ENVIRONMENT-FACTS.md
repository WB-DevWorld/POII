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
- The cause was not known when this was written. It was found later the same day: see "The cause of the pages that kept loading: HTTP/3" below. Nothing was read from the staging containers' logs.
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

### Later on 2026-11-25: a new build on staging

- PR #77 (time limits) merged as `d5555cdbdf71847ffe9b7def508f7c8c41f5ab99` at 13:22:54 UTC and PR #78 (this record) as `460ff8f00378d4e283384234ba87687a84b4b722` at 13:23:14 UTC.
- Staging serves `460ff8f00378d4e283384234ba87687a84b4b722` since 13:32:11 UTC: [Deploy staging run 45624443704](https://github.com/WB-DevWorld/POII/actions/runs/45624443704), attempt 1, started by [publish run 45624100048](https://github.com/WB-DevWorld/POII/actions/runs/45624100048). API `ghcr.io/wb-devworld/poii-api@sha256:79171a45ff44bf1351adf5d875358b6d38fc3fb50c5f034c5cc3711060c3b0d9`; web `ghcr.io/wb-devworld/poii-web@sha256:f07cef039f5ecf45978ce768154a7cee9b45653be351ba59f0b5e58cb9a32b13`. Manifest `staging-20261125T133211Z-460ff8f00378.json` (`previous`: `staging-20261124T182556Z-651c1eba6d2e.json`). `GET /health/ready` reported that SHA with `status: ready` at 13:32 and again at 15:19 UTC.
- No images were deployed for `d5555cd` alone. [Deploy staging run 45623915197](https://github.com/WB-DevWorld/POII/actions/runs/45623915197) stopped in its `gate` job, as designed: the two merges landed 20 seconds apart, so the publish run started for the first commit was reported for the second, and the gate refuses that mismatch ("main moved on between CI and publish"). The next chain deployed normally.

### The cause of the pages that kept loading: HTTP/3

Found on 2026-11-25 between 13:36 and 15:30 UTC. It was not POII.

- On the new build the owner saw the same hang again. With the time limits in place a stuck call inside POII would have ended in an `api_timeout` notice after 20 seconds, so the request was not stuck there.
- Watched in the owner's own Chrome, in the signed-in staging session, with the owner's agreement: that browser loaded staging over HTTP/3 (`nextHopProtocol` `h3`). Search and the source page loaded in 0.25 to 0.5 s. Opening a record from a search hit never left the search page, and from that moment every request from that browser to the staging host got no answer for more than a minute, including `/icon.svg`, `/health/ready` and `/signin`. After about 75 seconds the connection recovered by itself. A second run stalled the same way; in two of three tries the stall began on the record page (46 KB of HTML, plus a 112 KB script file).
- In the same minute, from the same machine but outside the browser, over TCP: `/signin` 200, `/decisions` 307 and `/health/ready` 200 in 0.5 to 0.7 s. The server was answering; the browser's HTTP/3 connection was dead.
- That explains the sequence of the first session: the page opened from the search hit stalls, Current decisions "never loads" because the whole connection is dead, and a later retry works.
- Why HTTP/3 was in use: Dokploy's Traefik enables HTTP/3 on its HTTPS entry point by default, so every response carried `Alt-Svc: h3=":443"; ma=2592000`.
- Why HTTP/3 stalled is not established. From other programs on that machine a QUIC connection to UDP 443 of the server never completed (idle timeout), with or without the stall, so the browser's HTTP/3 probably did not reach the server directly; HTTPS-scanning security software on that machine may sit in between. This was not examined further.
- **Change on the server, by the owner, at about 15:15 UTC:** the `http3` block was removed from the HTTPS entry point in Traefik's `traefik.yml` and Traefik was reloaded. This is a setting of the Dokploy server, not of this repository, and it applies to every application behind that Traefik.
- Observed afterwards: from 15:19 UTC responses carry no `Alt-Svc` header. In the owner's Chrome the page and every live request use `h2`; 18 requests in a row (12 for the large record pages, 6 for Current decisions) answered in 200 to 430 ms with no stall; 14 pages (home, sources, records, Current decisions, search, export, backup, tokens, account, import, add a source, the source page with and without the cited span, AI-assisted extraction) each loaded completely in 215 to 464 ms.
- One leftover in that browser: a script file of the record page stayed pending when requested through the browser's cache, held by a request left over from a stall, while the same file fetched past the cache came back in 0.2 s. Fetching it once with the cache bypassed cleared it. Restarting the browser clears any other such leftover.
- The two earlier guesses are settled as follows. The missing time limits were real and are fixed by PR #77, but they were not the cause. The shared Dokploy network (Isolated Deployment off) is not needed to explain anything seen; it has still not been examined.

### Later deploys on 2026-11-25

Staging serves `4c6e7964f86ab07be721fa9d0cd3ad4f3d745a08` since 17:11 UTC. Each row is a `Deploy staging` run whose smoke passed and whose manifest is under `infra/releases/`.

| Source | Deployed (UTC) | Deploy staging run | Digests | Manifest |
| --- | --- | --- | --- | --- |
| `3f3e68feaca52b0edfc34fb6c0960ac63aa01868` (PR #79, merged by the owner) | 2026-11-25 15:39:11 | [45647426749](https://github.com/WB-DevWorld/POII/actions/runs/45647426749), after publish run [45647139727](https://github.com/WB-DevWorld/POII/actions/runs/45647139727) | API `ghcr.io/wb-devworld/poii-api@sha256:9752fa0940768e4bbe1ca5342c03442290928dc3a474caa5890c31896978e51f`; web `ghcr.io/wb-devworld/poii-web@sha256:9039929d77e53234f0cd2bb07d560baacc4b00256c77e516415a63c94603e752` | `staging-20261125T153911Z-3f3e68feaca5.json` |
| `d0edd198ee1cf92a55cf90816b70c05963b09c52` (PR #81, merged by auto-merge) | 2026-11-25 16:47:32 | [45657579093](https://github.com/WB-DevWorld/POII/actions/runs/45657579093), after publish run [45657165730](https://github.com/WB-DevWorld/POII/actions/runs/45657165730) | API `ghcr.io/wb-devworld/poii-api@sha256:ba00eaa598c8293ef25e09d96aa8aea48d3f397afd91c426a8dd384785b74fe6`; web `ghcr.io/wb-devworld/poii-web@sha256:f1a7340fe26cbdcd262b7de2ba202f8cb6ed704f2cf67f9ee080e5c520a2db08` | `staging-20261125T164732Z-d0edd198ee1c.json` |
| `4c6e7964f86ab07be721fa9d0cd3ad4f3d745a08` (PR #85, the last of five merged by the owner within two minutes) | 2026-11-25 17:11:38 | [45661960922](https://github.com/WB-DevWorld/POII/actions/runs/45661960922), after publish run [45661614158](https://github.com/WB-DevWorld/POII/actions/runs/45661614158) | API `ghcr.io/wb-devworld/poii-api@sha256:46d5b23db752cfa0bd872ca4464e9713bfec0c1e3b0bc4cd2b0304409dbc14fc`; web `ghcr.io/wb-devworld/poii-web@sha256:433f11c02d036738707cf618abb99348537f0e2c2cb4c20371b08f8a8c3af24c` | `staging-20261125T171138Z-4c6e7964f86a.json` |

- From the deploy of `4c6e796` on, the smoke also checks that the host offers no HTTP/3 (#80): "no HTTP/3 offer (no Alt-Svc header naming h3)" passed in that run.
- `Deploy production` (#85) started after that staging deploy, said that production deploys are switched off, and deployed nothing: [run 45662164615](https://github.com/WB-DevWorld/POII/actions/runs/45662164615). It does start as the link after CI, publish and `Deploy staging`.
- [Deploy staging run 45661277560](https://github.com/WB-DevWorld/POII/actions/runs/45661277560) stopped in its `gate` job, as designed: five merges landed within two minutes, the publish run of the first was reported for the last, and the gate refuses that mismatch. The next chain deployed.
- Not observed: the sign-in fix of #82 on staging itself. It needs a person to sign out and in.

### What happened after the first auto-merge

#81 was the first pull request to merge by auto-merge since `main-ci-catchup.yml` exists (16:21 UTC, `d0edd198ee1cf92a55cf90816b70c05963b09c52`).

- Nothing started CI on `main`. The pull request's `classify` check had failed on a GitHub outage, was re-run, and finished eleven minutes after CI; the catch-up listened only for CI finishing. The bot dispatched the catch-up by hand at 16:29 UTC, and it started CI. #84 added the second trigger.
- That CI run passed at 16:33 UTC and nothing followed it: no publish, no deploy. GitHub raises no `workflow_run` event when a run started with the workflow token finishes. The two catch-up runs at 16:32 and 16:33 UTC came from the CI runs of two open pull requests.
- The same CI workflow dispatched by the bot app at 16:40 UTC was followed by the publish and the deploy in the table above; staging served `d0edd19` at 16:47 UTC.
- GitHub reported a partial outage from about 15:54 to 16:35 UTC. During it, checks failed on GitHub's own errors (the labels call of `classify`, the upload of a CodeQL result) and re-runs were refused for a while.

### Night of 2026-11-25: the second auto-merge, and the build staging serves

- #87 (dependency advisories) merged by auto-merge at 20:48:21 UTC as `4fb311f9407b7f14425c4ad55316b50b9b5562b1`. [Catch-up run 45698383888](https://github.com/WB-DevWorld/POII/actions/runs/45698383888) was already waiting for that merge, saw it, and started CI on `main` at 20:49 UTC ([CI run 45698593245](https://github.com/WB-DevWorld/POII/actions/runs/45698593245), passed). So the catch-up does start CI within about a minute of an auto-merge, which #81 had not shown. No images followed that run, as expected: the change that walks the rest of the path (#86) was not on `main` yet.
- The owner merged #86 at 20:54 UTC (`5b5d87f`) and #88 at 20:55 UTC (`a56f6841c871d8812a044289e74019eac7fbcd1b`).
- Staging serves `a56f6841c871d8812a044289e74019eac7fbcd1b` since 21:04 UTC: [Deploy staging run 45700853774](https://github.com/WB-DevWorld/POII/actions/runs/45700853774) after [publish run 45700556335](https://github.com/WB-DevWorld/POII/actions/runs/45700556335). API `ghcr.io/wb-devworld/poii-api@sha256:a2284f23aa0f6adf364da4191eef9e169897d3c964b9d03ca1ee384cb26736f1`; web `ghcr.io/wb-devworld/poii-web@sha256:ebf0b8fbfb931007cdfe133bb053d3fe4b7dd07ee6b94043c2c9bf28bb880666`. Its manifest `staging-20261125T210447Z-a56f6841c871.json` is not under `infra/releases/` yet. [Deploy staging run 45700232135](https://github.com/WB-DevWorld/POII/actions/runs/45700232135) before it stopped in its `gate` job, as designed (two merges a minute apart).
- The new catch-up script ran on GitHub for the first time in [run 45699476435](https://github.com/WB-DevWorld/POII/actions/runs/45699476435): checked out from `main`, and ended with "PR #88 is not auto-merging", which was correct. Its chain (CI, publish, deploy after an auto-merge) had not run for real at that point; it did at 21:11 UTC, see the next subsection.
- `pnpm audit` on `main` reports no known vulnerabilities since `4fb311f`.

### The first automatic chain after an auto-merge

#89, a routine documentation change, merged by auto-merge at 21:11:47 UTC on 2026-11-25 as `28c57955e1106b5a68c29677c8cf16ea104fa114`. Nobody started anything after that.

| Step | Run | Started (UTC) | Result |
| --- | --- | --- | --- |
| Catch-up sees the merge and finds no CI run for the head of `main` | [45702017969](https://github.com/WB-DevWorld/POII/actions/runs/45702017969) | 21:11:29, waiting for the merge | "PR #89 was merged by auto-merge." |
| CI on `main` | [45702233455](https://github.com/WB-DevWorld/POII/actions/runs/45702233455) | 21:12:48 | success |
| Publish immutable images | [45702960733](https://github.com/WB-DevWorld/POII/actions/runs/45702960733) | 21:17:25 | success |
| Deploy staging | [45703310651](https://github.com/WB-DevWorld/POII/actions/runs/45703310651) | 21:19:41 | success, smoke passed |

- Staging served `28c57955e1106b5a68c29677c8cf16ea104fa114` at 21:21 UTC (`deployedAt` 21:20:51), about nine minutes after the merge. API `ghcr.io/wb-devworld/poii-api@sha256:bd3d23bb46a7565480f431ab2ea0887b9901c71532b886029df10a0ee08a6679`; web `ghcr.io/wb-devworld/poii-web@sha256:e57430cf24f6289d29dacaa26b7edceea1d425be0a2f08cc30c3193fb86e1811`.
- Each of the three runs was started by the catch-up with the workflow token (`workflow_dispatch`, actor `github-actions[bot]`). The catch-up ended with "Production deploys are switched off. The chain ends here."
- This is what #81 and #87 had not shown: after an auto-merge the commit gets CI, images and a staging deploy by itself (#86).
- The manifest `staging-20261125T212051Z-28c57955e110.json` is not under `infra/releases/` yet, nor is the one of `a56f684`. Its `previous` names the newest manifest recorded on `main` (`staging-20261125T171138Z-4c6e7964f86a.json`), because the staging deploy takes `previous` from the newest manifest in the repository, not from the run before it.

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
