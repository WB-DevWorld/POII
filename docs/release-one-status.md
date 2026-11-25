# Release one: where it stands

Written 2026-11-25 against `main` `3f3e68f`. Release one is M1 plus M2 (`BUILD-BASELINE.md` §3). This page maps each acceptance criterion of §8 to the evidence that exists today and lists what is still open before the owner can accept release one and before production can be activated. It records evidence; it does not declare anything accepted. Acceptance and the activation phrase are the owner's.

How to read the verdicts: **covered** means an automated test that runs in CI on every pull request proves the claim; **partly** means a named part is not proven by any test; **staging** means it was also observed on the live staging host (`LIVE-ENVIRONMENT-FACTS.md`).

## Acceptance criteria (§8)

The tests run with AI and peers switched off unless the row says otherwise. Test names are quoted from the files.

| # | Claim | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Every manual journey step, end to end | `apps/api/test/api.journey.test.ts`, "ND-1 journey, backup, restore into an empty install, idempotent second restore": one journey over the HTTP API that loads all three fixtures. `apps/web/test/smoke.spec.ts`, "manual journey: source → candidates → confirm → supersede → current view → search → export": in a browser, on `decision-chain` only. | Covered through the API. Partly in the browser: one fixture, without the lifecycle status step and without backup and restore. Staging: sign-in, add source, candidate, confirm, search, evidence, current decisions (2026-11-25). |
| 2 | Restore into an empty install reproduces the workspace, with history and approvals | The journey test above compares every restored record, versions and approvals included, and the counts. `apps/api/test/ops.integration.test.ts`, "the runner output restores into an empty install with matching counts". | Covered. `infra/scripts/restore-drill.sh` runs in no workflow, and no drill has run on staging (no backup target yet). |
| 3 | A superseded decision is never current; every derived item opens its span; pack citations resolve | `api.invariants.test.ts`, "a confirmed decision with a confirmed successor is never current (chain of three)"; the browser smoke opens the cited span; the journey test checks the hash of every evidence span in the pack. | Covered. |
| 4 | Pasted assistant text is never the owner's statement; an approval links its exact antecedent | `api.invariants.test.ts`, "pasted assistant text stays attributed to the assistant; the approval names the owner"; the chain-of-three test. | Covered. |
| 5 | Missing or conflicting dates stay explicit; intent and observed reality can differ and both are shown | `api.invariants.test.ts`, "effectiveAtStatus unknown and conflicting round-trip with timeConflicts" (`price-conflict`); the journey test creates both records from `intent-vs-observed`. | Dates: covered. Intent versus observed: partly. Both records exist and keep their status, but no test asserts that a view, an export or a page shows them together. |
| 6 | Instructions hidden in sources never execute; duplicate imports and retries are idempotent | `api.invariants.test.ts`, "text inside a source is never interpreted (the SYSTEM NOTE changes nothing)", "duplicate imports return the existing source with deduplicated:true", "a retried mutating call with the same Idempotency-Key returns the first result". | Covered. |
| 7 | Access rules and token scopes hold on every interface; a token proposes but never confirms; revocation is immediate | `tokens.test.ts`, "read scope: reads sources, records, views, search and context packs; every write is 403", "propose scope: creates sources and candidates attributed to the token actor; never confirms, rejects, deletes, restores or changes policy", "revocation takes effect on the very next request"; `apps/mcp/test/mcp.test.ts` for the MCP server. | Covered. |
| 8 | Never-send content never reaches a provider request or its logs; deletion removes items from search and future exports | `ai.api.test.ts`, "a never-send source is refused before anything is built or sent, at preview and at execute" (provider MOCKED); `read-api.test.ts`, "no AI-context reply ever contained never-send content or the never-send source title"; `api.invariants.test.ts`, "deleting a source removes revisions and search hits; exports list it unavailable; evidence shows available:false". | Partly. "Logs" is proven for the audit table only; nothing reads the process output of the API. Deletion is proven for search and the context pack, not for a backup taken afterwards. |
| 9 | Caps stop AI calls; the manual path works when providers or peers are down | `ai.api.test.ts`, "at the cap execute is refused with cap_reached, nothing is sent, and the manual path keeps working" and "every AI endpoint answers 503 ai_disabled; the manual path is unaffected" (provider MOCKED); `auth.accesslobby.test.ts`, the "AccessLobby down" test. | Caps: covered. Partly for "down": no test runs the manual journey while a configured provider is unreachable. Staging: the cap accounting matched the provider's reported usage on the first real call (2026-11-25). |
| 10 | No secrets or private evidence in the repository, images, logs or artifacts | CI: gitleaks over the full history; `infra/scripts/forbidden-material.sh` (tracked file names); `infra/scripts/dokploy-deploy.test.mjs` proves the deploy script prints no environment values. | Partly. Nothing scans the built images, the application logs or the uploaded Playwright report. |

## What is still open

### Waiting for the owner

| Item | What it unblocks | Where the steps are |
| --- | --- | --- |
| API credit on the OpenAI account | The first real OpenAI call and the last "Waiting for staging" row of `docs/compatibility-matrix.md` (#13, #22) | `docs/runbooks/owner-setup.md` |
| A backup target (bucket and credentials in Dokploy) | The first scheduled backup on staging and the restore drill (#16), both required before production activation | `docs/runbooks/backup-and-restore-drill.md` |
| A decision on a staging credential for an automated browser | The Playwright core-journey smoke on staging, today skipped with its reason | `docs/runbooks/staging-deploy.md` |
| AccessLobby client registration | The first sign-in through the real AccessLobby (#17, M3, not part of release one) | `docs/runbooks/accesslobby-client-registration.md` |
| Three policy questions from 2026-10-12 | Whether never-send record titles are withheld from AI clients too; a separate MindMesh spending cap; whether back-channel logout ends every POII session or only the matching one | `CURRENT-WORK.md`, entry of 2026-10-12 |

### Open in the code

| Gap | Why it matters | Size |
| --- | --- | --- |
| No production deploy path. `docs/release-policy.md` step 4 (promote the staging digest to production; gated changes through the `production-gated` environment) has no workflow. | Production cannot be activated, with or without the phrase. | Large: workflow, runbook, tests, in the release-enforcement class. Needs a production Dokploy service and hostname decision first. |
| `restore-drill.sh` runs in no workflow. | Criterion 2 is proven by API tests, but the drill script itself can rot. | Small. |
| Criterion 5: nothing asserts intent and observed are shown together. | A claim of §8 without a direct test. | Small: one assertion on the current view or the pack for `intent-vs-observed`. |
| Criterion 8: process logs are not checked for never-send text; a backup after a deletion is not checked. | Two claims of §8 proven only in part. | Small to medium. |
| Criterion 9: no manual journey with an unreachable provider. | "Providers down" is only proven as "AI switched off" and "cap reached". | Small. |
| Criterion 10: images, logs and the Playwright report are not scanned. | A claim of §8 that rests on file names and git history only. | Medium. |
| The browser journey covers one fixture and skips lifecycle status, backup and restore. | The page for those steps has no browser test. | Medium. |

### Not open

- Local sign-in and owner tokens (#14): merged, 169 API tests in CI, and used on staging by the owner since 2026-11-24.
- Staging with continuous deployment (#15): every merge to `main` deploys to staging since 2026-11-24; three release manifests are recorded under `infra/releases/`.
- The page hang seen on staging on 2026-11-25 was the HTTP/3 offer of the server's Traefik, not POII (`LIVE-ENVIRONMENT-FACTS.md`, 2026-11-25).
