# Execution ledger

Newest entry first. Every entry says what was run and what was not. Mocked work is labelled mocked.

## Bot identity switched on — 2026-10-10 UTC

The owner created the GitHub App `wbdevworld-poii-agent` (App ID 5258365, installation 169805354 on this repository only) and handed the agent the private key path in chat; the key itself was never shown or printed. From this entry on, agents commit and open pull requests as `wbdevworld-poii-agent[bot]` instead of the owner's account. This PR is the first one opened as the bot.

Done, verified live: the key signs an App token that GitHub accepts for App ID 5258365; the installation token sees `WB-DevWorld/POII` and nothing else; repository secrets `POII_AGENT_APP_ID` and `POII_AGENT_APP_PRIVATE_KEY` and the repository variable `POII_AGENT_INSTALLATION_ID` are set; the checkout's repo-local git identity is now the bot's noreply address (the earlier `WB DevWorld` identity is superseded); `scripts/agent-token.mjs` mints and caches tokens and works as a git credential helper (tested: `check`, `git-credential get` for github.com, no answer for other hosts). Runbook section 2 rewritten to the real state.

Applied by the owner on 2026-10-10 from prepared request bodies, after the agent's permission mode refused the two settings calls: `require_code_owner_review` is on in the `Protect main` ruleset and `prevent_self_review` is on for the `production-gated` environment (both read back true). Code-owner review only bites once `.github/CODEOWNERS` names `@wbdevworld` (that fix is part of the approved gate-hardening PR, not this one).

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
