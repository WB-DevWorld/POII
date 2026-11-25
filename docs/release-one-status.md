# Release one: where it stands

Written 2026-11-25 against `main` `3f3e68f`; updated the same evening against `4c6e796`, after #80 to #85 merged. Release one is M1 plus M2 (`BUILD-BASELINE.md` §3). This page maps each acceptance criterion of §8 to the evidence that exists today and lists what is still open before the owner can accept release one and before production can be activated. It records evidence; it does not declare anything accepted. Acceptance and the activation phrase are the owner's.

How to read the verdicts: **covered** means an automated test that runs in CI on every pull request proves the claim; **partly** means a named part is not proven by any test; **staging** means it was also observed on the live staging host (`LIVE-ENVIRONMENT-FACTS.md`).

## Acceptance criteria (§8)

The tests run with AI and peers switched off unless the row says otherwise. Test names are quoted from the files.

| # | Claim | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Every manual journey step, end to end | `apps/api/test/api.journey.test.ts`, "ND-1 journey, backup, restore into an empty install, idempotent second restore": one journey over the HTTP API that loads all three fixtures. `apps/web/test/smoke.spec.ts`, "manual journey: source → candidates → confirm → supersede → current view → search → export": in a browser, on `decision-chain` only. `apps/web/test/signin.spec.ts`: the same build under local sign-in, from the redirect to sign-out. | Covered through the API. Partly in the browser: one fixture, without the lifecycle status step and without backup and restore. Staging: sign-in, add source, candidate, confirm, search, evidence, current decisions (2026-11-25). |
| 2 | Restore into an empty install reproduces the workspace, with history and approvals | The journey test above compares every restored record, versions and approvals included, and the counts. `apps/api/test/ops.integration.test.ts`, "the runner output restores into an empty install with matching counts". `infra/scripts/restore-drill.sh` runs in CI on every pull request since #83. | Covered. No drill has run on staging (no backup target yet). |
| 3 | A superseded decision is never current; every derived item opens its span; pack citations resolve | `api.invariants.test.ts`, "a confirmed decision with a confirmed successor is never current (chain of three)"; the browser smoke opens the cited span; the journey test checks the hash of every evidence span in the pack. | Covered. |
| 4 | Pasted assistant text is never the owner's statement; an approval links its exact antecedent | `api.invariants.test.ts`, "pasted assistant text stays attributed to the assistant; the approval names the owner"; the chain-of-three test. | Covered. |
| 5 | Missing or conflicting dates stay explicit; intent and observed reality can differ and both are shown | `api.invariants.test.ts`, "effectiveAtStatus unknown and conflicting round-trip with timeConflicts" (`price-conflict`). `intent-observed.api.test.ts` (#83), "the record list of the source shows the intended decision as decided and the observed fact as observed, side by side" and "the context pack shows both in JSON and in Markdown, each with its lifecycle status, time and exact excerpt" (`intent-vs-observed`). | Covered through the API and the pack. Both are shown side by side; nothing links the two records or flags that they differ, and no browser test looks at it. |
| 6 | Instructions hidden in sources never execute; duplicate imports and retries are idempotent | `api.invariants.test.ts`, "text inside a source is never interpreted (the SYSTEM NOTE changes nothing)", "duplicate imports return the existing source with deduplicated:true", "a retried mutating call with the same Idempotency-Key returns the first result". | Covered. |
| 7 | Access rules and token scopes hold on every interface; a token proposes but never confirms; revocation is immediate | `tokens.test.ts`, "read scope: reads sources, records, views, search and context packs; every write is 403", "propose scope: creates sources and candidates attributed to the token actor; never confirms, rejects, deletes, restores or changes policy", "revocation takes effect on the very next request"; `apps/mcp/test/mcp.test.ts` for the MCP server. | Covered. |
| 8 | Never-send content never reaches a provider request or its logs; deletion removes items from search and future exports | `ai.api.test.ts`, "a never-send source is refused before anything is built or sent, at preview and at execute" (provider MOCKED); `read-api.test.ts`, "no AI-context reply ever contained never-send content or the never-send source title"; `ai.process-logs.test.ts` (#83), "never-send text and titles never reach stdout or stderr across refusals, AI-context reads, an allowed execution, a provider failure and error paths"; `api.invariants.test.ts`, "deleting a source removes revisions and search hits; exports list it unavailable; evidence shows available:false"; `deletion.backup.test.ts` (#83), "a backup taken after deleting a source holds none of its text, and restoring it into an empty install does not bring the text back". | Covered for the wording of the claim. Three things stay behind on the instance where a source is deleted and wait for the owner's decision, see below. |
| 9 | Caps stop AI calls; the manual path works when providers or peers are down | `ai.api.test.ts`, "at the cap execute is refused with cap_reached, nothing is sent, and the manual path keeps working"; `ai.provider-down.test.ts` (#83, provider MOCKED as refusing, never answering and answering 5xx), "with the providers still down the manual journey works in the same instance: source, candidate, confirm, search, current decisions, context pack"; `auth.accesslobby.test.ts`, the "AccessLobby down" test. | Covered. Staging: the cap accounting matched the provider's reported usage on the first real call (2026-11-25). |
| 10 | No secrets or private evidence in the repository, images, logs or artifacts | CI: gitleaks over the full history; `infra/scripts/forbidden-material.sh` (tracked file names); `infra/scripts/dokploy-deploy.test.mjs` proves the deploy script prints no environment values; the sign-in browser run writes no report and no trace, because both would hold the typed password. | Partly. Nothing scans the built images, the application logs on a server or the uploaded Playwright report of the other browser run. |

## What is still open

### Waiting for the owner

| Item | What it unblocks | Where the steps are |
| --- | --- | --- |
| API credit on the OpenAI account | The first real OpenAI call and the last "Waiting for staging" row of `docs/compatibility-matrix.md` (#13, #22) | `docs/runbooks/owner-setup.md` |
| A backup target (bucket and credentials in Dokploy) | The first scheduled backup on staging and the restore drill there (#16), both required before production activation | `docs/runbooks/backup-and-restore-drill.md` |
| Production setup and the first activation | A Dokploy production service, the `production` GitHub environment, secrets in both production environments, then the phrase, a dry run and the switch | `docs/runbooks/production-deploy.md` |
| What deletion leaves behind | A context pack exported before a deletion is still served with the deleted excerpts; stored replies for the `Idempotency-Key` header keep deleted text with no expiry; the deleted title stays in the manifests of earlier packs. Purge, expire or keep? | #83 |
| How records of deploys are classed | `infra/releases/**` is gated, so each pull request that records a manifest makes the next production promotion wait for the owner. Batch the records, or give record-only changes their own class? | ADR-0013 |
| A decision on a staging credential for an automated browser | The Playwright core-journey smoke on staging, today skipped with its reason | `docs/runbooks/staging-deploy.md` |
| AccessLobby client registration | The first sign-in through the real AccessLobby (#17, M3, not part of release one) | `docs/runbooks/accesslobby-client-registration.md` |
| Three policy questions from 2026-10-12 | Whether never-send record titles are withheld from AI clients too; a separate MindMesh spending cap; whether back-channel logout ends every POII session or only the matching one | `CURRENT-WORK.md`, entry of 2026-10-12 |

### Open in the code

| Gap | Why it matters | Size |
| --- | --- | --- |
| The production promotion workflow has never run. `deploy-production.yml` (#85) is on `main`, switched off. | What GitHub does with waiting approvals, the concurrency group and the owner as both actor and reviewer can only be seen on a first real run (ADR-0013). | Depends on the owner's setup; then a dry run. |
| An auto-merged commit gets CI but no images and no deploy. | Routine changes reach staging only with the next merge pressed by a person, or when CI is started as the bot. | #86 (open when this was written) makes the catch-up walk the whole path. |
| `drizzle-kit generate` would write a wrong migration. `apps/api/drizzle/meta` holds snapshots only for migrations 0000 and 0001. | Nothing at run time uses the generator, but the next generated migration would recreate ten tables. | Small, in the schema class: regenerate the snapshots and prove a no-op. |
| Criterion 10: images, server logs and the Playwright report of the local-owner run are not scanned. | A claim of §8 that rests on file names and git history only. | Medium. |
| The browser journey covers one fixture and skips lifecycle status, backup and restore. | Those pages have no browser test. | Medium. |
| Intent versus observed: both are shown, nothing marks them as a pair. | The claim's wording is met; a reader has to notice the difference themself. | A product decision before any code. |

### Not open

- Local sign-in and owner tokens (#14): merged, in CI, and used on staging by the owner since 2026-11-24. The defect found on 2026-11-25 (the sign-in form stayed after a correct password until a reload) is fixed by #82, and a browser test of sign-in runs in CI.
- Staging with continuous deployment (#15): every merge to `main` pressed by a person deploys to staging since 2026-11-24; six release manifests are recorded under `infra/releases/`.
- The page hang seen on staging on 2026-11-25 was the HTTP/3 offer of the server's Traefik, not POII. The staging smoke fails if the offer comes back (#80).
- The moderate dependency advisories of 2026-11-25 (hono, `@hono/node-server`, esbuild): cleared by #87 (open when this was written); none was reachable in POII.
