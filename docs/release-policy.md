# Release policy — continuous deployment with gated classes

Version 2 · 2026-10-10 · Version 1 was approved by the owner with the build commission of 2026-10-09. Version 2 was approved by the owner in chat on 2026-10-10 as part of the gate-hardening PR; it changes no rule, it describes what is actually enforced. Later changes to this file are gated.

## Pull requests and CI

- Trunk-based work with small PRs and squash merges. Every change goes through a PR; nothing is pushed to `main` directly after the seed commit.
- CI on every PR: frozen install, lint, typecheck, unit tests, integration tests against PostgreSQL, migrations from empty and from the previous release, build, Playwright smoke of the core journey, secret scanning (gitleaks plus GitHub push protection), dependency review and Dependabot, CodeQL, and the release-policy coverage check (below).
- A ruleset protects `main` and requires these checks.
- Routine PRs auto-merge when green. Gated PRs wait for the owner's explicit approval.

## Release path

1. On merge to `main`, CI builds one immutable image per app and pushes it to GHCR, tagged with the commit SHA and identified by digest.
2. That digest is deployed to staging automatically (M2, not yet active).
3. Smoke, acceptance and migration checks run on staging.
4. If the change is routine and staging is green, the same digest is promoted to production automatically (not before the first production activation).

Gated changes go through the `production-gated` GitHub environment with the owner as required reviewer. Anything unclassified counts as gated.

## Gated classes

- Identity, auth, sessions, permissions or tokens.
- Information policy: disclosure, retention, deletion.
- Canonical ownership, the data model, schema and migrations, and the export and context-pack format.
- Destructive or backward-incompatible migrations.
- New spending, provider code, or changes to the caps.
- Licence or repository visibility.
- Changes to other peers.
- The release workflows, the risk classifier, the coverage check, `CODEOWNERS`, the Compose file and this policy itself. Their initial setup was approved by the commission; every later change is gated.
- The first production activation.

"First implementation" of a gated area is not an exemption. Only the initial setup of the release workflows, the risk classifier and this policy was pre-approved. Every other gated change waits until the owner types `POII GATED APPROVED: PR #N` in chat.

## Classification

- Classification is path-based and lives in `.github/release-policy/risk-classes.json`. The `risk-classify` workflow applies the policy from the base branch (never the PR's copy) to every PR and reports the class as the required check `classify` and as a label.
- `.github/release-policy/sensitive-areas.json` describes where sensitive code actually lives as path patterns. `check-coverage.mjs` runs in the required `verify` check and fails when any tracked file in a sensitive area is not matched by a gated rule, so a new identity, token, deletion, AI, export, schema or release file cannot be routine by omission.
- Labels can raise the risk class (`risk:gated`), never lower it. A PR that touches a gated path is gated whatever its labels say.
- A PR that cannot be classified is gated.

## What is enforced today (10 October 2026, after the bot switch-over)

Enforced by GitHub or CI:

- PRs are required for `main`; squash only; linear history; no bypass actors; required checks `verify`, `classify`, `dependency-review`, `analyze`.
- Agents commit and open PRs as the GitHub App identity `wbdevworld-poii-agent[bot]` (installed on this repository only), never through the owner's account, so an approval by the owner on GitHub approves someone else's PR. `scripts/agent-token.mjs` mints the bot's token; see `docs/runbooks/owner-setup.md` section 2.
- The `Protect main` ruleset requires code-owner review. `CODEOWNERS` names the owner (`@wbdevworld`) for the release policy, workflows, classifier, scripts, ADRs, baseline, ownership, schema, migrations, Compose and `infra/`; a PR that touches those paths cannot merge until the owner approves it on GitHub.
- The `production-gated` environment has the owner as required reviewer with prevent-self-review on.
- `classify` labels every PR `risk:gated` or `risk:routine` and enables auto-merge only for routine PRs.
- The coverage check fails `verify` when a sensitive file is not gated.
- Secret scanning with push protection, gitleaks over the full history, dependency review, CodeQL.

Still held by the rule and the record, not by a setting:

- A gated PR that touches no code-owner path (for example only application code in a gated class) is blocked by nothing technical once CI is green; `classify` reports and labels, it does not fail. The gate is the owner's phrase in chat, quoted in `CURRENT-WORK.md`, and the rule that agents never merge a gated PR without it.
- Routine PRs auto-merge with zero approving reviews by design (`required_approving_review_count` is 0); code-owner review applies only to the protected paths.

## Possible next step

Change `classify` to fail on gated PRs until an approving review by the owner exists on the PR, so the chat phrase becomes a record and the GitHub review the technical gate for every gated class. Separate gated PR, not started.

## Rules that keep it safe

- Deploys run one at a time. A running migration is never cancelled. The previous digest is kept for one-step rollback. Rolling back the app and restoring the database are separate procedures with separate runbooks.
- Agents never read, print or hold production credentials. Deploy credentials live in GitHub environments and in Dokploy, scoped to `main`.
- **Approval identity.** Agents act as `wbdevworld-poii-agent[bot]`. Gated items wait for the owner's approval phrase in chat, recorded in `CURRENT-WORK.md`, and for the owner's review on GitHub where code-owner paths are touched. Agents never call approval or bypass endpoints.
- **First production activation** needs the owner's phrase `POII PRODUCTION ACTIVATION APPROVED`, given after staging is shown green, the restore drill has passed and the secrets are set. After that, routine releases go out without the owner.

## What is recorded where

- CI results: on the PR and in `CURRENT-WORK.md` with exact SHAs and run links.
- Published digests: in the publish workflow summary and in `infra/releases/`.
- Observed deployments and health: in `LIVE-ENVIRONMENT-FACTS.md`, separately from CI success.
- Owner approvals of gated items: in `CURRENT-WORK.md`, quoting the approval phrase and date, and in the owner's private POII instance.
