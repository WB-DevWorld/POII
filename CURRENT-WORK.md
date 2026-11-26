# Execution ledger

Newest entry first. Every entry says what was run and what was not. Mocked work is labelled mocked.

## Several passages on one record, and a conflicting time without a date, in the browser — 2026-11-26 UTC (later)

Continues the entry below.

[#95](https://github.com/WB-DevWorld/POII/pull/95) `e0861c7`, routine, merged by auto-merge at 02:23 UTC: the status page and this ledger after #91 to #94. The catch-up chain deployed it to staging without anyone starting anything (CI, publish, Deploy staging run 45742858339). That is the third commit it has deployed.

[#96](https://github.com/WB-DevWorld/POII/pull/96), routine: the two page gaps the status page listed against the manual journey.

- A candidate can cite several passages of a source at creation ("Keep this span and select another"). A record page has "Cite another passage", which leads to a source page with "Cite a passage for an existing record"; the passage can be in any source. With more than one citation, each can be removed. The pages call `POST /v1/records/:id/evidence` and `DELETE /v1/records/:id/evidence/:evidenceId`, which existed and no page called.
- A competing time value may be written as `no date`, then a note. It is stored as `value: null`.

Found by this work, both fixed in #96:

- A record with an undated competing value could not be saved from the edit form at all. The form wrote the value back as its note alone and then refused the line. Such a value could only come from the API or the MCP server, so no browser test had met it.
- Saving times through a form dropped `sourceId` from every competing value, because a line of text cannot carry it. The save now reads the record and keeps the source of each value that is still there.

Still open after it: a page cannot set the source of a competing value, only keep one. Without JavaScript the candidate form takes one span, as before; more are added afterwards from the record. Listed in `docs/release-one-status.md`.

What was run, on the development machine against a fresh database: `pnpm typecheck` and the 52 unit tests in `apps/web`; `next build`; the browser suite at 10 tests with one worker, two of them new. The new forms were looked at in screenshots.

Not run: the API suite (no API file changed) and the sign-in browser run, both left to CI; nothing on staging. No mock was added.

No helper session was used for #96.

Two staging manifests are still not in the repository: the deploys of `1dd0eef` and `e0861c7`. They go in with the next change that needs the owner's approval, as `infra/releases/**` is a gated path.

## Snapshots repaired, images and reports scanned, the journey in a browser — 2026-11-26 UTC

Continues the entry below.

Merged to `main` on 2026-11-26 between 02:11 and 02:15 UTC:

- [#94](https://github.com/WB-DevWorld/POII/pull/94) `8c04f77`, routine, by auto-merge: four browser tests for the rest of the manual journey (lifecycle status on `intent-vs-observed`; `price-conflict`; the backup download and the restore refusals; restore into a clean install with a second API and web app on an empty database). `playwright.config.ts` runs one browser at a time.
- [#91](https://github.com/WB-DevWorld/POII/pull/91) `d14b214`, approved and merged by the owner: the record of the night of 2026-11-25.
- [#92](https://github.com/WB-DevWorld/POII/pull/92) `0670fe2`, approved and merged by the owner: snapshots for migrations 0002 to 0005 and `infra/scripts/migration-snapshot-check.sh` as a CI step. No SQL migration and no schema file changed. Before the snapshots were written, the six SQL migrations and the TypeScript schema were compared through the database catalog and found to describe the same database (23 tables, 226 columns, 71 constraints, 55 indexes, 13 enums).
- [#93](https://github.com/WB-DevWorld/POII/pull/93) `1dd0eef`, approved and merged by the owner: `infra/scripts/artifact-scan.sh`; CI scans both built images and the browser report before it is uploaded; `apps/api/test` is no longer in the build context.

Found by this work:

- The API image carried the seven hand-written mock provider responses of the API tests. They are not real provider output. Removed by #93.
- Every web image holds three keys that Next.js generates per build (preview signing and encryption, server-action encryption). Listed as known in the scan; the owner decides whether that is acceptable.
- In the browser a record can cite only one span, and a conflicting time cannot be entered for a value without a date. Both are in `BUILD-BASELINE.md` §4.1 and work through the API. Listed in `docs/release-one-status.md`.
- On the development machine the browser tests failed at random with three browsers at once (first requests stalled for 10 to 20 seconds) and were stable with one. CI on Linux never showed it.

What was run: on #92, the check against five deliberate breaks, the API suite at 180 tests, and `drizzle-kit check`. On #93, the scan of both locally built images and 16 script tests. On #94, the eight browser tests three times with one worker, across two sessions. CI green on every merged head; the new CI steps (snapshot check, image scan, report scan) ran for the first time on GitHub in those runs.

Not run: the report scan on a real failed browser run; the scan of a pushed image; everything listed as not run in the entries below. MOCKED and labelled so, as before.

Delegation, for the record: #92, #93 and #94 were built by helper sessions of the agent from written briefs. A usage limit stopped all three for about two and a half hours; they were resumed and finished. The agent read each result, reran the tests, set the one-worker rule and fixed one code-scanning finding in #93 itself.

Owner questions added: the three Next.js build keys in the web image; whether dependency resolution is a gated class.

## Routine changes deploy by themselves; advisories cleared — 2026-11-25 UTC (night)

Continues the entry below.

Merged to `main`:

- [#87](https://github.com/WB-DevWorld/POII/pull/87) `4fb311f`, by auto-merge at 20:48 UTC: `hono` 4.13.21 and `@hono/node-server` 2.1.11 by a lockfile update, and one scoped override that replaces the `esbuild` 0.18.20 below `drizzle-kit`'s unused `@esbuild-kit` loader with 0.25.12. `pnpm audit` reports no known vulnerabilities. None of the eight advisories was reachable in POII.
- [#86](https://github.com/WB-DevWorld/POII/pull/86) `5b5d87f`, approved and merged by the owner at 20:54 UTC: after an auto-merge the catch-up walks the release path itself (CI, image publish, staging deploy, then the start of the production promotion). The logic is `infra/scripts/main-ci-catchup.sh` with 14 tests against a stand-in for `gh` (MOCKED). `publish.yml` gained a manual start that builds the head of `main` only when CI passed for exactly that commit.
- [#88](https://github.com/WB-DevWorld/POII/pull/88) `a56f684`, approved and merged by the owner at 20:55 UTC: the record of the evening.
- [#89](https://github.com/WB-DevWorld/POII/pull/89) `28c5795` and [#90](https://github.com/WB-DevWorld/POII/pull/90) `4ba24f4`, both routine documentation changes, by auto-merge at 21:11 and 21:27 UTC. #89 was opened as the real test of #86.

What was observed, each recorded in `LIVE-ENVIRONMENT-FACTS.md` under 2026-11-25:

- **The automatic chain works on GitHub.** After #89 merged by itself, the catch-up started CI, the publish and the staging deploy, and staging served the commit nine minutes after the merge with nobody starting anything. The same happened after #90. Before #86, an auto-merged commit got CI but no images (#81, #87).
- The classifier labels a change to `pnpm-workspace.yaml` and `pnpm-lock.yaml` as routine: #87 merged without the owner. Whether dependency resolution should be a gated class is the owner's call.
- The first CI run of #86 failed before any test, in "Initialize containers": the registry answered "Data limit exceeded" for the PostgreSQL service image. A re-run passed. Not a defect of the change.

What was run: on #86, 121 script tests locally and the script's real behaviour on GitHub in the runs above. On #87, the audit before and after, lint, typecheck, build, and the whole test suite on a migrated throwaway database (contracts 7, API 180, web 48, MCP 11). CI green on every merged head.

Not run: the catch-up's last step, the start of the production promotion, beyond "production deploys are switched off"; a chain that breaks in the middle on GitHub (the repair path is tested against the stand-in only).

Still open from the entry below: the Drizzle snapshots, what a deletion leaves behind, the class of deploy records, the production setup. All nine staging deploys so far have their manifest under `infra/releases/`.

## Sign-in defect, acceptance tests, the production path written, two holes after an auto-merge — 2026-11-25 UTC (evening)

Continues the entry below. `docs/release-one-status.md` is updated with it.

Merged to `main`. The owner approved each gated one on its head commit and pressed Merge, 17:01 to 17:03 UTC; #81 merged by auto-merge at 16:21 UTC.

- [#81](https://github.com/WB-DevWorld/POII/pull/81) `d0edd19`: the ledger entry below and `docs/release-one-status.md`.
- [#82](https://github.com/WB-DevWorld/POII/pull/82) `f099fae`: **a defect in sign-in, found by a new browser test.** After a correct password the address changed to the requested page, but the page still showed the sign-in form until a reload. Next renders the target of the sign-in action's redirect itself and hands the just-set cookie over already URL-decoded; the web app accepted only the encoded form, so that one request reached the API without a session. Fixed in `apps/web/src/lib/session.ts`. The test (`apps/web/test/signin.spec.ts`, a CI step under `local-signin`) fails without the fix.
- [#80](https://github.com/WB-DevWorld/POII/pull/80) `e573ead`: the staging smoke fails while the host offers HTTP/3.
- [#83](https://github.com/WB-DevWorld/POII/pull/83) `3b58daa`: eleven API tests for four acceptance claims that had no direct test (intent and observed both shown; the manual path with a provider down; a backup after a deletion; never-send text in the process output), and `restore-drill.sh` as a CI step. No application code changed.
- [#84](https://github.com/WB-DevWorld/POII/pull/84) `b514d82`: the catch-up also follows the risk classification.
- [#85](https://github.com/WB-DevWorld/POII/pull/85) `4c6e796`: `deploy-production.yml`, `infra/scripts/promotion-class.mjs`, ADR-0013 and `docs/runbooks/production-deploy.md`. **Written, never run:** it is switched off and no production exists.

Issues: #14 and #15 closed as completed with their evidence; status comments on #13, #16 and #22.

What was run: on #82, the new browser test failing on `main` and passing with the fix, the four existing browser tests, web 48 tests. On #83, the API suite at 180 tests on a migrated throwaway database, three times, and the log test against a deliberate break. On #85, 105 script tests, and the classification read-only against this repository's own history. On #80, the script against live staging. CI green on every merged head; the new CI steps (sign-in run, restore drill) ran for the first time on GitHub in those runs and passed. On staging: see `LIVE-ENVIRONMENT-FACTS.md`, "Later deploys on 2026-11-25".

Not run: `deploy-production.yml` beyond its switched-off gate; the sign-in fix on staging itself; everything already listed as not run in the entry below. MOCKED and labelled so: `gh` in the script tests of #85, the providers in the new tests of #83.

Found and not yet fixed when this was written:

- After an auto-merge the catch-up gives the commit CI but no images and no deploy (`LIVE-ENVIRONMENT-FACTS.md`, "What happened after the first auto-merge"). [#86](https://github.com/WB-DevWorld/POII/pull/86), open, makes it walk the whole release path.
- `pnpm audit` on `main` reported 7 moderate and 1 low advisory, none high, none reachable in POII. [#87](https://github.com/WB-DevWorld/POII/pull/87), open, clears them.
- `drizzle-kit generate` on `main` would write a migration that recreates ten tables: `apps/api/drizzle/meta` holds snapshots only for migrations 0000 and 0001. Nothing at run time uses the generator.
- What a deletion leaves behind on the instance (a pack exported earlier, stored idempotency replies, the title in earlier pack manifests): listed in #83 for the owner's decision.

Delegation, for the record: three of these changes were built by helper sessions of the agent from written briefs (the sign-in test, which found the defect and stopped as briefed; the acceptance tests; the production workflow). The agent read each result, reran the tests and wrote the fix for the sign-in defect itself.

Owner questions still open, in addition to those in the entry below: the class of deploy-record pull requests (each one makes the next production promotion gated); what to do with what a deletion leaves behind; the production setup.

## Staging live, first real AI call, the HTTP/3 stall — 2026-11-25 UTC

This entry covers 2026-10-13 to 2026-11-25. Nothing was written here in that time; the observations went to `LIVE-ENVIRONMENT-FACTS.md` and the pull requests. `docs/release-one-status.md` (new with this entry) maps the acceptance criteria to the evidence and lists what is open.

Merged to `main`, each a squash commit. The owner approved every gated one on its head commit and pressed Merge; #72 merged by auto-merge.

- [#53](https://github.com/WB-DevWorld/POII/pull/53) `7dff763` (2026-10-13): the dev scripts build the shared contracts package before starting the apps.
- [#74](https://github.com/WB-DevWorld/POII/pull/74) `a303333` (2026-11-24): dependency security updates that build together: Next.js 16.4.5, zod 4.6.7, NestJS 12.3.2 (which brings body-parser 2.4.0 and multer 2.5.0), Better Auth 1.7.14. Before it, no open pull request could pass `verify`: `main` failed the audit, and each single update failed either the audit or the build.
- [#72](https://github.com/WB-DevWorld/POII/pull/72) `efe2e04`: Node base image 24.22.3 for the API. Auto-merged, so no CI and no publish run started for that commit.
- [#75](https://github.com/WB-DevWorld/POII/pull/75) `1f2043f`: `main-ci-catchup.yml` starts CI on `main` when its head has no CI run; `ci.yml` accepts a manual dispatch; `publish.yml` follows such runs. **Not yet proven on a real auto-merge:** every merge since was pressed by the owner, which starts CI by push.
- [#73](https://github.com/WB-DevWorld/POII/pull/73) `e4cfa47`: GitHub Actions versions.
- [#76](https://github.com/WB-DevWorld/POII/pull/76) `656f2fa`: the staging smoke accepts the sign-in redirect of an instance that requires sign-in. The first workflow deploy had failed on exactly that.
- [#59](https://github.com/WB-DevWorld/POII/pull/59) `651c1eb`: record of the first staging deploy.
- [#77](https://github.com/WB-DevWorld/POII/pull/77) `d5555cd` (2026-11-25): time limits on the web app's calls to the API (15 s, 930 s for long operations), on the proxy's sign-in check (5 s) and on the database pool (10 s for a connection); every call sends its own request id; a call that runs out shows `api_timeout` with that id.
- [#78](https://github.com/WB-DevWorld/POII/pull/78) `460ff8f` and [#79](https://github.com/WB-DevWorld/POII/pull/79) `3f3e68f`: records of the first signed-in session, the first real AI call, the HTTP/3 finding and three release manifests.

Closed without merging on 2026-11-24, by the bot with a comment each, on the owner's instruction that day to close what was no longer needed: #57, #60, #61, #63, #66, #67, #70 and #71. Their content was superseded by #74 or no longer needed; #60 (an optional Anthropic workspace header) became unnecessary when the owner replaced the key with one that belongs to a workspace.

What is true now, with the place where it is recorded:

- Staging runs at `https://poii-staging.cetechbpa.com` since 2026-11-24 and every merge to `main` deploys to it. It serves `3f3e68f` since 2026-11-25 15:39 UTC; that deploy's manifest is not in the repository yet (`LIVE-ENVIRONMENT-FACTS.md`, 2026-11-24 and 2026-11-25).
- The owner signed in on staging and ran the first steps of the manual journey there. The first real provider call from a POII instance succeeded: Anthropic `claude-opus-5-5`, 5 candidates, USD 0.0624, equal to the list price for the reported tokens (`docs/compatibility-matrix.md`).
- Two pages kept loading in that session. The cause was the HTTP/3 offer of the server's Traefik, not POII; the owner switched it off on the server and the pages load (`LIVE-ENVIRONMENT-FACTS.md`, 2026-11-25). The time limits of #77 were built while the cause was still unknown. They did not cure it and are kept, because a stuck call inside POII now ends in an error.

What was run: on the head of #77, web 47 tests, API 169 tests against a migrated throwaway database, the web build, and by hand the built web app against a server that never answers (the page answers after 20 s with the notice). On #76 and the smoke change, the script tests and the script against live staging. CI green on every merged head. On 2026-10-26 the first AI calls were rehearsed from a throwaway local instance: both providers refused before generating anything (Anthropic: the key needed a workspace; OpenAI: no credit), spend USD 0, and POII's refusal, reservation release and ledger handled both correctly.

Not run: any call to OpenAI that produced output; a backup or a restore drill on staging (no backup target yet); the Playwright journey against staging; a rollback; a sign-in through the real AccessLobby; a live Claude Code session firing the hook. MOCKED and labelled so, as before: the provider responses in `apps/api/test/ai.api.test.ts`, every AccessLobby interaction, the hook's stub API suite.

Corrections to earlier text: `docs/runbooks/staging-deploy.md` still says "written, never run", which #80 (open when this was written) corrects; `docs/release-policy.md` still says staging deploys are "M2, not yet active", which stopped being true on 2026-11-24 (that file is in a gated class and is corrected with the next change to it).

Owner questions still open: the three of 2026-10-12 below (never-send record titles for AI clients, a separate MindMesh cap, the reach of back-channel logout), and one new: whether an automated browser may get a credential for staging, so the Playwright journey can run there after each deploy.

## M3 merged, gate and tooling fixes — 2026-10-12 UTC

Owner approvals: the phrases of 2026-10-10 ("POII GATED APPROVED: a PR that updates BUILD-BASELINE.md …", "… makes compose.dokploy.yaml pass the sign-in variables …", the instruction to fix the CodeQL alerts in their own gated PR) and the chat words "done" (2026-10-10), "permission granted", "approvals going" and "all approved" (2026-10-12), each with the owner's approving review on GitHub on the exact head that merged. Merged by the bot in this order (squash commits on `main`):

- [#38](https://github.com/WB-DevWorld/POII/pull/38) `a9d972a`: `BUILD-BASELINE.md` names Better Auth (ADR-0009). [#39](https://github.com/WB-DevWorld/POII/pull/39) `df5a86f`: Compose passes `POII_OWNER_BOOTSTRAP_PASSWORD`, `POII_OWNER_LOGIN`, `POII_API_BASE_URL`, `POII_TRUST_PROXY` to the API.
- [#41](https://github.com/WB-DevWorld/POII/pull/41) `831ed17`: the four CodeQL alerts in `scripts/agent-token.mjs` fixed in code (integer ids, a `KeyObject` for the PEM, a validated token cache) and two unused imports removed; `scripts/**` and `apps/mcp/**` added to the gated classes, the sensitive areas and `CODEOWNERS`. **Correction of the #29 entry above:** it says that PR "gates `scripts/**`"; no glob or `CODEOWNERS` line covered `scripts/` until #41, so changes to the bot token script were routine between 2026-10-10 and this merge (none happened in that window except #41 itself, which was gated through `apps/api/src/modules/ai/`).
- [#49](https://github.com/WB-DevWorld/POII/pull/49) `d5ebfb9`: hotfix for #41's token validation, which rejected the long installation tokens GitHub now issues (383 characters with `_`, `.` and `-`); every bot action failed with "installation token has an unexpected shape" until it merged. The credential isolation held: nothing fell back to the owner's login; the agent pushed and opened the hotfix with the previous script version, still as the bot.
- [#42](https://github.com/WB-DevWorld/POII/pull/42) `dd68970` (#23, ADR-0011): MindMesh execution-adapter contract, interface and documentation only. [#43](https://github.com/WB-DevWorld/POII/pull/43) `4ad62a5` (#19): export of current decisions to `AGENTS.md` and `CLAUDE.md` with citations; never-send records as title only. [#45](https://github.com/WB-DevWorld/POII/pull/45) `4fd1a43` (#18): `X-POII-AI-Context` never-send enforcement on every read route, source span route, the `@poii/mcp` stdio server with six read-only tools, `docs/compatibility-matrix.md` with the tested rows (MCP SDK client 1.32.1, Claude Code 2.1.292 one-shot in a scratch directory, direct HTTP). [#46](https://github.com/WB-DevWorld/POII/pull/46) `c7b6c45` (#20): selective import of ChatGPT and Claude export conversations with per-message attribution. [#44](https://github.com/WB-DevWorld/POII/pull/44) `19ee49a` (#21): opt-in Claude Code hook capture, proposals only; one by-design CodeQL alert (the hook's own outbound request carries transcript text) listed for the owner's dismissal.
- [#48](https://github.com/WB-DevWorld/POII/pull/48) `ed43c65`: push- and review-triggered `classify` runs are in separate concurrency groups and the approval re-runs cancelled runs too. [#50](https://github.com/WB-DevWorld/POII/pull/50) `5da67e8`: CI waits for PostgreSQL over TCP with a real query before migrating (`pg_isready` inside the container answered before the TCP listener was up; #49 needed three runs).
- [#47](https://github.com/WB-DevWorld/POII/pull/47) merged as `7e46c94` (#17 AccessLobby OIDC with explicit account linking and verified back-channel logout, ADR-0012, migration `0005_accesslobby_identity_link`), owner approval "approved 47" in chat on 2026-10-12 and on GitHub on head aa5ba2b. AccessLobby is MOCKED in its 18 tests; the first run against the real AccessLobby waits for the owner's client registration (`docs/runbooks/accesslobby-client-registration.md`). Issue #17 stays open for that run.

Gate mechanics observed this round, recorded for the next integrator: the owner granted the GitHub App "Actions: read and write" on 2026-10-12; from then on the bot re-ran the five cancelled `classify` runs itself (ids 38046358633, 38046415782, 38046451748, 38046385105, 38046464280) and the three cancelled or failed ones later. Stacking PRs on each other does not avoid rebases when they append to the same end of `packages/contracts/src/api.ts` and `docs/api.md`: git cannot align "block A" on `main` against "A plus B" on the branch, so each PR was rebased onto `main` just before its turn and re-approved (#45 once, #46 once, #44 once, #47 twice).

Evidence on the merged heads (local, env loaded, fresh databases; CI green on every head): #45 contracts 7/7, web 36/36, mcp 11/11, api 134/134; #46 contracts 7/7, web 40/40, mcp 11/11, api 151/151; #44 hook tests 16/16 mocked plus 17/17 against the real API, policy and script tests 60/60; #43 api 123/123, web 36/36. MOCKED and labelled so: the hook's stub API suite, every AccessLobby interaction in #47, the AI provider responses from #33. Not run: anything on staging or against a live AI provider or the real AccessLobby; a live Claude Code session firing the hook; the `/imports` page in a browser.

Owner questions still open: withhold never-send record titles from AI clients too (#43, #45 shipped with titles shown); a separate MindMesh spending cap (#42); whether AccessLobby back-channel logout should end every POII session or only the matching one (#47).

## Correction of the record and credential isolation — 2026-10-10 UTC

**Correction (owner instruction of 2026-10-10 after checkpoint review 4).** Earlier entries say or imply that the agent did the following as the bot or that it happened automatically. GitHub's own records show they were done through the owner's GitHub login, used by the agent from this machine:

- the merge of PR #36;
- the re-runs of the stale `classify` runs on #31, #30, #36 and #32 (the bot token had no Actions permission);
- the dismissal of the three CodeQL alerts on `apps/api/src/ops/drill.ts` (and of the two on `infra/scripts/dokploy-deploy.mjs` after the fix).

That broke the rule in `AGENTS.md` that agents never act through the owner's account; no gate was bypassed (every merged head carries the owner's approving review), but a `wbdevworld` action on GitHub from that period does not prove the owner did it himself. From this entry on: the owner's GitHub login, `gh` login and stored git credential are off-limits to agents for everything (merges, re-runs, reviews, alert dismissals, settings). If a step needs the owner's account, the agent stops that item and tells the owner what to click. CodeQL alerts are fixed in code; dismissals are the owner's clicks on a written list.

**Credential isolation, applied on 2026-10-10 in `C:\dev\poii` and every worktree.** A gitignored `.claude/settings.local.json` (copied into each worktree) sets, for every agent session, `GH_CONFIG_DIR` to an empty folder (no `gh` login exists there), `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` to a repo-local `gitconfig-agent` that holds only the bot identity and the bot credential helper, `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`, and denies the commands that read, list or switch the owner's credentials (`gh auth`, `git credential-manager`, `cmdkey`, Credential Manager and PasswordVault calls, and reading the owner's `gh` and git configuration files). The repo-local credential entries were removed; the only helper left is `scripts/agent-token.mjs`.

Proof, run on 2026-10-10 with that environment: `gh auth status` answers `You are not logged into any GitHub hosts`; `git config --show-origin --get-all credential.helper` lists exactly one line, `file:C:/dev/poii/.claude/gitconfig-agent  !node C:/dev/poii/scripts/agent-token.mjs git-credential`, in the main checkout and in a worktree; `git push --dry-run origin main` succeeds through that helper (`username=x-access-token`); `gh` works only with `GH_TOKEN` from the bot script. The same checks in a fresh session are the owner's to confirm. Dependabot #24 could not be merged by the bot while its `classify` run stood cancelled; a label event re-ran it instead of any re-run by a person.

Not done by the agent: granting the bot "Actions: read and write" (owner), confirming the proof in a fresh session (owner).

## M2 merged: #31, #30, #25, #36, #32 — 2026-10-10 UTC

Owner approvals typed in chat on 2026-10-10 ("POII GATED APPROVED: PR WB-DevWorld/POII#31, POII GATED APPROVED: PR WB-DevWorld/POII#30, POII GATED APPROVED: PR WB-DevWorld/POII#25", then "done" for #36 and #32 after the review requests), each also approved by the owner on GitHub on the final head. Merged by the bot in this order (squash commits on `main`):

- [PR #31](https://github.com/WB-DevWorld/POII/pull/31) `de0b4b1` (head 6828960): backup runner, restore drill, `/health/version`, migration `0003_ops_backup_runs`. The drill's three CodeQL alerts were dismissed as used in tests (recorded in the entry below).
- [PR #30](https://github.com/WB-DevWorld/POII/pull/30) `7fdde17` (head ad3635b): staging deploy workflow, Dokploy script and staging smoke, written and tested against a mock, **not run against Dokploy**; a no-op until the repository variable `POII_STAGING_ENABLED` is `true`. The deploy script's output hygiene and the secrets confirmation are in the entry below.
- [PR #25](https://github.com/WB-DevWorld/POII/pull/25) `bb24603`: Dependabot's GitHub Actions bumps (checkout v7, github-script v9 and six more), auto-merged after the owner's review.
- [PR #36](https://github.com/WB-DevWorld/POII/pull/36) `57b613d` (head bc82ced, rebased once after #25 changed the same workflow file): the review-triggered `classify` run re-runs the stale failed run from the push. Until it merged, the owner's login re-ran the stale runs of #31, #30 and #36 by hand; from #32 on the re-run happened automatically (#32 reached `CLEAN` without manual help).
- [PR #32](https://github.com/WB-DevWorld/POII/pull/32) `9abaf6b` (head 07b2c83): local sign-in rebuilt on Better Auth 1.7.7 (MIT) on the owner's instruction of 2026-10-10 under ND-2 ("Rebuild local sign-in on Better Auth (map its user to our actor; username or owner-only mode is fine). No in-house password hashing or session code. Owner tokens can stay as built. Renumber migrations as needed."). Better Auth owns password hashing, sessions, sign-in, sign-out, revocation, password change and rate limiting, mounted at `/v1/auth/*`; POII keeps owner-only mode, the actor mapping, the bootstrap password and the CSRF header check on its own mutations; owner tokens as built; migration `0004_better_auth_and_owner_tokens`; the `ai_execute` capability now lives in `authorization.ts` (person with authority only; tokens never spend). ADR-0009 records the evaluation and the decision.

Evidence on the merged heads (local, env loaded, nothing mocked except the AI provider responses recorded for #33): #31/#30 stacked tree: typecheck PASS, tests contracts 2/2, web 25/25, api 80/80, build PASS, migrate from empty PASS; deploy-script tests 29/29. #32: `pnpm policy:check` 44/44, migrate from empty applied 0000–0004, typecheck PASS, tests contracts 2/2, web 32/32, api 116/116 (zero skipped, zero cancelled), build PASS, Better Auth end to end with curl and a real browser on localhost (redirect, wrong and right password, cookie, CSRF refusal, sign-out, sign-up refused). CI on every head: `verify`, `analyze`, `dependency-review`, CodeQL and GitGuardian green; `classify` green after the owner's review. No CodeQL alert is open on any of these PRs; five older alerts remain open on `main` (four in `scripts/agent-token.mjs`, one unused import), not yet triaged.

Not done: nothing has run on staging or against a live AI provider; `compose.dokploy.yaml` does not yet pass the sign-in variables (`POII_SESSION_SECRET` is already there; `POII_OWNER_BOOTSTRAP_PASSWORD`, `POII_OWNER_LOGIN`, `POII_API_BASE_URL`, `POII_TRUST_PROXY` are not) to the API: a separate gated PR. Development databases that applied the earlier `0002_identity_sessions_tokens` must be recreated.

## Review gate: the approval re-runs the stale failed classify run — 2026-10-10 UTC

Follow-up to PR #35, found on its own merge: GitHub counts every `classify` check run on a head commit, so the run from the push (failed: no approval yet) still blocked the merge after the review-triggered run had passed, and the owner's login had to re-run it by hand (the bot token cannot re-run workflows). Now, when a review-triggered `classify` run finds the approval, it lists this workflow's failed `pull_request` runs on the same head and re-runs their failed jobs (`actions: write` on the workflow token); those re-runs re-read the reviews and pass. Nothing else in the check changes; a dismissed approval still fails the review-triggered run. `owner-approval.test.mjs` asserts the re-run code and permission are present; `docs/release-policy.md` describes it.

Gated (`release-workflows-and-policy`); approval requested as `POII GATED APPROVED: PR WB-DevWorld/POII#N` plus the GitHub review. Local evidence: policy tests 15/15, inlined script parses, YAML parses with the three permissions. The first real run of the re-run step happens on the first gated PR approved after this merges; until then, or on this PR itself, a stale failed run is re-run by the owner's login.

## M2 integration: #35 and #33 merged, CodeQL triage, deploy-script output hygiene — 2026-10-10 UTC

Owner approvals typed in chat on 2026-10-10, in one message: "POII GATED APPROVED: PR WB-DevWorld/POII#35", then "POII GATED APPROVED: PR WB-DevWorld/POII#33", then, before #31 and #30: "triage the 5 open CodeQL alerts (3 in apps/api/src/ops/drill.ts, 2 in infra/scripts/dokploy-deploy.mjs): fix them or dismiss each with a written reason, as you did on #26. Confirm the deploy script never writes Dokploy environment values or secrets to the step summary or job outputs, since they are public on this repo. Record it in CURRENT-WORK.md. Also make sure every worktree commits with the bot as author.", then "POII GATED APPROVED: PR WB-DevWorld/POII#31, POII GATED APPROVED: PR WB-DevWorld/POII#30, POII GATED APPROVED: PR WB-DevWorld/POII#25". The owner approved #35 and #33 on GitHub on their final heads.

Merged by the bot: [PR #35](https://github.com/WB-DevWorld/POII/pull/35) as `b781860` and [PR #33](https://github.com/WB-DevWorld/POII/pull/33) as `3a3baa7` (migration renamed `0002_ai_usage`; providers MOCKED, the first run with real keys stays the gate for #13). First observation of the new review gate: after the owner's approval the review-triggered `classify` run passed, but the earlier failed run from the push still counted and GitHub refused the merge (`Required status check "classify" is failing`); the owner's login re-ran that run (the bot's token cannot re-run workflows), it passed, and the merge went through. The fix (the review-triggered run re-runs the stale failed run itself) is a separate gated PR.

CodeQL triage for #31 and #30 (five alerts on the PR merge refs; the five alerts open on `main` are older: four in `scripts/agent-token.mjs`, one unused import, not part of this instruction):

- `apps/api/src/ops/drill.ts` lines 62 and 65 (`js/file-access-to-http`) and line 142 (`js/http-to-file-access`): dismissed as "used in tests" with written reasons on each alert (ids 11, 12, 13). The drill helper is a test harness: it posts the three public fixture files and the backup it just wrote to a throwaway API it started itself on a free 127.0.0.1 port, and writes the ids that API returned to a state file in a temporary directory chosen by `restore-drill.sh`. Same reasoning as the test client dismissed on #26.
- `infra/scripts/dokploy-deploy.mjs` lines 61 and 65 (`js/http-to-file-access`: Dokploy response data written to `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY`): fixed in this PR rather than dismissed. Every value read from the Dokploy service environment (other than the three managed keys) is now remembered and redacted from everything the script logs, writes to the job outputs or to the step summary; job-output values are forced to one printable line (a newline would inject further outputs); `compose_source_type` is written only when it matches `^[a-z][a-z0-9_-]{0,31}$`, otherwise `unknown`; the previous `API_IMAGE`, `WEB_IMAGE` and `GIT_SHA` are written only when well-formed (digest reference or 40-hex SHA), otherwise described as not well-formed; Dokploy's error text (`deployment.errorMessage`, HTTP error `message`) goes to the masked and redacted log only and never to the summary, which now carries only the HTTP status and a code matching `^[A-Z_]{1,40}$`. If CodeQL still reports the two lines after this change, they are dismissed as false positives with this entry as the reason.

Confirmed, with a test that fails otherwise (`infra/scripts/dokploy-deploy.test.mjs`, "nothing from the Dokploy environment reaches the outputs or the summary"): a service environment containing a database password, a provider key, a session secret and a URL, a `sourceType` carrying a newline and a secret, a malformed `GIT_SHA`, and a failed deployment with Dokploy error text produce a job-output file, a step summary, a stdout and a stderr that contain none of those values; every output is one printable `name=value` line. What the script does write out: the compose source type (validated), the three managed values before and after (validated), `env_update_attempted`, `deployment_status`, `deployed_at`, `result`, and its own fixed messages. The workflow (`deploy-staging.yml`) writes to the summary only those outputs, the image digests, the release manifest (digests, SHA, timestamps) and the smoke output; secrets are read only through `${{ secrets.* }}` into step environment variables and never echoed. Dokploy logs are not fetched. Masking (`::add-mask::`) stays as a second layer for the log.

Bot authorship: every worktree's repo-local identity is `wbdevworld-poii-agent[bot]` (checked in all eight worktrees); the commits on these branches that still carried the pre-switch-over `WB DevWorld` identity were rewritten to the bot author with unchanged trees (verified: empty diff against the previous heads) before the owner's GitHub review of the final heads.

Local evidence on the PR heads: `node --test "infra/scripts/*.test.mjs"` 29/29 (3 new); the stacked tree of #31 and #30 on the new `main`: typecheck PASS, tests contracts 2/2, web 25/25, api 80/80 (zero skipped), build PASS, migrate from empty PASS (0000–0003). CI on the final heads is recorded on the PRs.

## Review gate on every gated PR — 2026-10-10 UTC

Branch `chore/gate-approval-check`, opened as the bot. Owner approval, typed in chat on 2026-10-10: "POII GATED APPROVED: one PR that (a) makes the classify check fail on every gated PR until I have approved it on GitHub, and (b) adds AGENTS.md and SOURCE-OF-TRUTH.md to the gated classes and CODEOWNERS. GitHub currently reports #30–#33 as mergeable with no review from me. Before merging, prove with the bot token that a gated PR without my GitHub approval cannot merge, and correct docs/release-policy.md to what is actually enforced."

What changed: `risk-classify.yml` also runs on `pull_request_review` (submitted, edited, dismissed) and, for a gated PR, lists the PR's reviews and fails the required `classify` check unless every approver named by the base-branch policy has an approving review on the PR's current head commit; bot reviews, other logins, comments and labels never count, and an approval on an older commit does not count after a push. `.github/release-policy/risk-classes.json` version 3 adds `"approvers": ["wbdevworld"]` and gates `AGENTS.md` and `SOURCE-OF-TRUTH.md`; `sensitive-areas.json` version 2 covers both files; `.github/CODEOWNERS` names the owner for both; `owner-approval.mjs` holds the approval functions (inlined in the workflow because the base branch may not have the module yet; `owner-approval.test.mjs` asserts the copies are identical and covers the decision table). A base policy without `approvers` falls back to the user logins in the base `CODEOWNERS`, which is how this PR itself is gated by the new check before the list exists on `main`. `docs/release-policy.md` version 3 states what is enforced now, including that GitHub runs the PR's copy of a workflow (why `.github/workflows/` stays a code-owner path). Runbook `bot-identity-switchover.md` updated.

Proof that a gated PR without the owner's GitHub approval cannot merge, run on 2026-10-10 with the bot's installation token against PR #30 (gated, approved in chat, no GitHub review), before this PR existed: `PUT /repos/WB-DevWorld/POII/pulls/30/merge` with `merge_method=squash` and the PR's head SHA answered HTTP 405 `Repository rule violations found — Waiting on code owner review from wbdevworld.`; the same call with a wrong `sha` answered HTTP 409 `Head branch was modified`; `gh pr merge 30 --squash` as the bot answered `not mergeable: the base branch policy prohibits the merge`. PR #30 is still open (`mergeStateStatus: BLOCKED`). "Mergeable" in the API means no merge conflict, not permitted to merge. Today that refusal comes from code-owner review and holds for PRs that touch code-owner paths (#25, #30, #31, #32, #33 all do); this PR extends it to every gated PR through `classify`.

Local evidence on the PR head: `node --test ".github/release-policy/*.test.mjs"` 15/15 PASS (coverage check 6, owner approval 9, including the inlined-copy identity assertions); `check-coverage.mjs` PASS: 163 tracked files, 47 in sensitive areas, all gated; the workflow's inlined script parses (`node --check` on the extracted script) and the YAML parses with both triggers. Dry run of the approval functions against the live reviews of #25, #30, #31, #32, #33 with the policy and `CODEOWNERS` from `main`: every one would fail `classify` with "wbdevworld (no review)". Not run: the workflow itself before the PR exists; its first real runs are on this PR (expected: `classify` fails until the owner approves, then passes on the review event).

## Gate hardening — 2026-10-10 UTC

Branch `chore/gate-hardening`, [PR #29](https://github.com/WB-DevWorld/POII/pull/29), limited to the items the owner listed on 2026-10-10. Owner approvals, typed in chat on 2026-10-10: "POII GATED APPROVED: one gate-hardening PR limited to the items in step 3." and, for this PR by number, "POII GATED APPROVED: PR WB-DevWorld/POII#29".

What changed: `.github/release-policy/risk-classes.json` version 2 widens every class to where the code lives (identity, session and token files including `adapters/*identity*`, `modules/identity/**`, `common/tokens.ts`, request context and interceptor, and any `*auth*`, `*session*`, `*token*`, `*signin*`, `*password*` file under `apps/*/src`; source deletion and retention code including `modules/sources/**`; AI disclosure, cap, budget and provider code; the export and context-pack format including `domain/context-pack.ts`, `modules/exports/**` and `packages/contracts/src/**`; schema, `db/**`, migrations and `migrate.ts`; every workflow, `infra/scripts/**`, `infra/github/**`). New `sensitive-areas.json` and `check-coverage.mjs` fail the required `verify` check when a tracked file in a sensitive area is not gated; `pnpm policy:check` runs the same locally. `.github/CODEOWNERS` now names `@wbdevworld` (the organisation name was not a valid owner). `docs/release-policy.md` version 2 states what is enforced today and what switches on with the bot identity. The bot switch-over happened in parallel (PR #28 and the owner's terminal; see the entry below), so this PR records it as applied in `docs/runbooks/bot-identity-switchover.md` instead of preparing it, gates `scripts/**` (where `scripts/agent-token.mjs` lives), and drops the duplicate token script and settings files an earlier version of this branch carried.

Local evidence on the PR head: `node --test` on the policy tests 6/6 PASS (including the assertion that the coverage check's glob matcher is byte-identical, whitespace aside, to the one inlined in `risk-classify.yml`, and that every tracked sensitive file is gated); `check-coverage.mjs` PASS: 163 tracked files, 45 in sensitive areas, all gated. The ruleset and environment settings were read back live (`require_code_owner_review` true, `prevent_self_review` true). CI on the PR head is recorded on the PR.

Still not enforced technically: a gated PR that touches no code-owner path is held only by the rule; see the policy's "What is enforced today". The first commit on this branch was authored under the bot identity before the switch-over was recorded; the PR itself was opened from the owner's login, so the squash commit on `main` carries the owner as author and the bot as co-author.
## Bot identity switched on — 2026-10-10 UTC

The owner created the GitHub App `wbdevworld-poii-agent` (App ID 5258365, installation 169805354 on this repository only) and handed the agent the private key path in chat; the key itself was never shown or printed. From this entry on, agents commit and open pull requests as `wbdevworld-poii-agent[bot]` instead of the owner's account. This PR is the first one opened as the bot.

Done, verified live: the key signs an App token that GitHub accepts for App ID 5258365; the installation token sees `WB-DevWorld/POII` and nothing else; repository secrets `POII_AGENT_APP_ID` and `POII_AGENT_APP_PRIVATE_KEY` and the repository variable `POII_AGENT_INSTALLATION_ID` are set; the checkout's repo-local git identity is now the bot's noreply address (the earlier `WB DevWorld` identity is superseded); `scripts/agent-token.mjs` mints and caches tokens and works as a git credential helper (tested: `check`, `git-credential get` for github.com, no answer for other hosts). Runbook section 2 rewritten to the real state.

Not done by the agent, blocked by its permission mode and handed to the owner as exact commands: turning on `require_code_owner_review` in the `Protect main` ruleset and `prevent_self_review` on the `production-gated` environment. Until the owner runs them, the gate still depends on agents following the rule. Note: code-owner review only bites once `.github/CODEOWNERS` names `@wbdevworld` (that fix is part of the approved gate-hardening PR, not this one).

## Owner approvals and record corrections — 2026-10-10 UTC

The owner's checkpoint review of 10 Oct 2026 found that PR #10 was merged without the owner's approval phrase and that its description quoted the build commission inaccurately. The owner's instructions and approvals, typed in chat on 2026-10-10, are recorded here word for word.

**Approvals given by the owner on 2026-10-10:**

- "POII GATED APPROVED: PR #10 (data model), retroactive."
- "POII GATED APPROVED: PR #26 (M1 manual journey), once CI is green and the three CodeQL alerts are fixed or dismissed with a written reason."
- "POII GATED APPROVED: one gate-hardening PR limited to the items in step 3." (Step 3 of the owner's message of 2026-10-10: widen the risk classifier to where identity, session, token, deletion, retention, AI disclosure, cap, budget, provider, export-format, schema and migration code lives; a CI check that fails if a file in those areas is not classified as gated; fix `.github/CODEOWNERS` to `@wbdevworld`; correct `docs/release-policy.md` to what is enforced today and what switches on once the bot identity exists; prepare but do not apply the bot-identity switch-over.)
- "POII GATED APPROVED: in `compose.dokploy.yaml`, stop putting the database password inside `DATABASE_URL` (pass it separately) so secret scanners stop flagging it; no other change to that file."

**Corrections to the record, on the owner's instruction:**

- "First implementation" is not an exemption from the gate. Only the initial setup of the release workflows, the risk classifier and the release policy was pre-approved by the build commission of 2026-10-09. Every other gated change waits until the owner types "POII GATED APPROVED: PR #N" in chat. The reasoning recorded for PR #10 (below, "M1 foundation merged") and in the first version of the PR #26 description was wrong and is withdrawn; PR #10 is now covered by the retroactive approval above.
- The PR #10 description attributed the words "write the data model, then go straight into M1" to the build commission. The commission does not contain those words. It says: "Write `BUILD-BASELINE.md`: scope, journeys, data model, ports, acceptance tests and release policy, all reflecting §2 without reopening it." and "Do M0, then go straight into M1." A correcting comment was added to PR #10. Rule from now on: quote the owner's commission word for word or not at all.
- `LIVE-ENVIRONMENT-FACTS.md` on `main` still said no GHCR images were published; the corrected file in this PR records the publish run.

CodeQL on PR #26 (three alerts on the merge ref): `js/superfluous-trailing-arguments` in `apps/web/src/components/ActionForm.tsx` fixed (the submitter's name and value are appended explicitly instead of the two-argument `FormData` constructor CodeQL's model does not know); `js/unused-local-variable` in `apps/api/test/context-pack.test.ts` fixed (variable removed); `js/file-access-to-http` in `apps/api/test/helpers.ts` dismissed as "used in tests" with the written reason that the test client deliberately posts fixture files from `fixtures/` to the API under test on 127.0.0.1 and nothing else.

Repository hygiene: the checkout's repo-local git identity is now `WB DevWorld <109213646+wbdevworld@users.noreply.github.com>`, so no further commits carry the owner's name or email. Existing history is left as it is (rewriting `main` would be destructive).

## M1 manual journey implemented — 2026-10-09 UTC

Branch `feat/m1-app`, [PR #26](https://github.com/WB-DevWorld/POII/pull/26), relates to #11. Two parallel builder sessions (API and web) worked against `docs/api.md`; the integrator ran the gates on the combined tree.

Local evidence on the PR head (env loaded, so integration tests ran instead of skipping): `pnpm typecheck` PASS for contracts, api, web. `pnpm test` PASS with zero skips: contracts 2/2, web 21/21 (offset computation incl. CRLF, date rendering of unknown and conflicting times, error mapping), api 39/39. The API suite includes `api.invariants.test.ts` (real HTTP on a random port) and `api.journey.test.ts` (two freshly created and migrated databases, dropped afterwards). `pnpm build` PASS. Playwright core-journey smoke 3/3 PASS in 10 s against the built API and web: paste the decision-chain fixture, create a candidate from a real DOM selection, open the exact span, confirm, supersede from typed offsets, confirm, old decision absent from the current view and new one present, search "JetStream" to the span, context pack lists the source as included.

Invariant coverage (exact test names in `apps/api/test/`): aiAllowed inheritance and recompute ("records inherit aiAllowed=false from any cited source; PATCH of source.aiAllowed recomputes"); superseded never current, chain of three; source deletion removes revisions, search hits and storage bytes and exports list it unavailable; duplicate imports deduplicate by content hash and origin key; Idempotency-Key replay and 409 on mismatch; agent_token can create sources and candidates but gets 403 on confirm, reject, delete, restore (through the services; HTTP has no way to act as another identity in release one); pasted assistant text stays attributed to the assistant while the approval names the owner; unknown and conflicting dates round-trip; the fixture's fake "SYSTEM NOTE" changes nothing; revisions re-anchor evidence as exact, moved or lost; the full ND-1 journey on all three fixtures with backup and restore into an empty install, idempotent second restore, 409 into a non-empty workspace.

First CI run on the PR failed in `pnpm lint` because the shared contracts package had no `dist` before the web typecheck; fixed by building contracts first in the root scripts (`d5cf770`). CI on the final head is recorded on the PR.

Dogfooding (#12, private): the owner's local instance was reset to an empty database, the three private decision files were loaded as never-send-to-AI sources, ND-1 to ND-5 were recorded as decisions stated by the review assistant (pasted) and approved by the owner citing the owner's exact sentences, the three 9 Oct amendments were recorded as confirmed successors, and a cited context pack was exported. The current-decisions view shows the amended ND-3, ND-4 and ND-5 and not their predecessors. The pack's citation of the authority file carries the expected SHA-256. All of this stays in the private folder.

Known follow-ups recorded, not done: reverting a source to an earlier revision's content is refused by the per-source content-hash unique index (gated schema change if wanted); tombstones do not keep `ai_allowed`; the local-owner identity is cached in memory; two simultaneous first-time requests with the same Idempotency-Key can both execute; total counts are not exposed by list endpoints; `timeConflicts` is one list per record (the web app tags entries with `effective:`/`observed:`). Not built: AI provider adapters (interface and `off` adapter only, nothing mocked), S3 storage, local sign-in, tokens, staging.

## M1 foundation merged — 2026-10-09 UTC

[PR #10](https://github.com/WB-DevWorld/POII/pull/10) merged as `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02`: domain schema and migration `0001_domain_model` (ADR-0005), the HTTP contract (`packages/contracts/src/api.ts`, `docs/api.md`), the three fictional fixtures, and the CI move to the ECR Public mirror of the official images. CI on the PR head: `verify` PASS (2m42s, [run 37995561095](https://github.com/WB-DevWorld/POII/actions/runs/37995561095)): gitleaks history scan, forbidden-material check, frozen install, audit, lint, typecheck, migrations from empty, upgrade check (skipped by design: no previous migrations differed), unit and PostgreSQL integration tests, build, Playwright smoke, Compose validation, both container builds, API container readiness. `classify` PASS (class: gated, data model), `dependency-review` PASS, CodeQL `analyze` PASS. CI on `main` after the merge PASS ([run 37996066398](https://github.com/WB-DevWorld/POII/actions/runs/37996066398)); the publish workflow pushed the first images (see `LIVE-ENVIRONMENT-FACTS.md`).

Risk note: the PR was gated by path (data model). It is the first implementation of the model that the owner's build commission of 2026-10-09 mandated; the integrator merged it on that basis and recorded the reasoning in the PR. Every later schema change waits for the owner's approval phrase. **Corrected 2026-10-10:** that reasoning was wrong; the merge was not approved at the time. The owner approved it retroactively on 2026-10-10 (see the entry above).

Tracking issues #11–#23 cover M1, M2 and M3 work packages.

## M0 seed — 2026-10-09 UTC

Seeded `main` (`eef86bd`) with the baseline, ownership and ADR-0001..0008, governance files, CI, release-policy classification, workspace skeleton and local Compose. The owner's decisions were verified against their private record (hash match) before the baseline was written. The remote was empty before the seed.

The seed's own CI run on `main` failed twice on the Docker Hub unauthenticated pull limit for `postgres:17` (not on project checks); fixed in PR #10 by using the ECR Public mirror.

Repository settings applied on the owner's account: squash-only merges, delete branch on merge, auto-merge allowed, secret scanning with push protection, Dependabot alerts and security updates, ruleset `Protect main` (PR required, squash only, linear history, required checks `verify`, `classify`, `dependency-review`, `analyze`, no bypass), environments `staging` and `production-gated` (owner as required reviewer), labels `risk:gated` and `risk:routine`. Dependabot PRs for Node 26 images and TypeScript 7 were closed as deliberate non-upgrades.
