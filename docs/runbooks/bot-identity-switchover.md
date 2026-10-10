# Bot identity switch-over

Applied on 2026-10-10 by the owner and a parallel agent session; recorded here so the policy's "what is enforced" section has one place to point at. The live description of the bot identity is `docs/runbooks/owner-setup.md` section 2.

## What was applied

1. GitHub App `wbdevworld-poii-agent` created and installed on `WB-DevWorld/POII` only (installation 169805354). Repository secrets `POII_AGENT_APP_ID` and `POII_AGENT_APP_PRIVATE_KEY` and the variable `POII_AGENT_INSTALLATION_ID` exist. The private key is a file outside every repository on the owner's machine.
2. Agents commit as `wbdevworld-poii-agent[bot] <340397344+wbdevworld-poii-agent[bot]@users.noreply.github.com>` and push and open PRs with tokens from `scripts/agent-token.mjs` (repo-local git credential helper; `GH_TOKEN=$(node scripts/agent-token.mjs) gh pr create ...`). First bot PR: #28.
3. Ruleset `Protect main` (id 24817305): `require_code_owner_review: true`, applied by the owner from their terminal. `required_approving_review_count` stays 0, so routine PRs still auto-merge; code-owner review bites on the `CODEOWNERS` paths only.
4. Environment `production-gated`: `prevent_self_review: true`, owner as required reviewer.

## Checks

```bash
gh api repos/WB-DevWorld/POII/rulesets/24817305 --jq '.rules[] | select(.type=="pull_request") | .parameters.require_code_owner_review'
gh api repos/WB-DevWorld/POII/environments/production-gated --jq '.protection_rules[] | select(.type=="required_reviewers") | .prevent_self_review'
node scripts/agent-token.mjs check
```

All three answered `true`, `true` and the App slug with an expiry on 2026-10-10.

## Review gate on every gated PR (applied 2026-10-10)

The `classify` check fails on every gated PR until the owner's approving review exists on the PR's current head commit (`.github/release-policy/owner-approval.mjs`, imported by `risk-classify.yml` from the base branch). A gated PR that touches no code-owner path is therefore held by a required check, not only by the rule in `docs/release-policy.md`.

## If the key is rotated or the App is removed

Generate a new key in the App settings, replace the PEM file and the `POII_AGENT_APP_PRIVATE_KEY` secret, delete the old key. If the App is removed, agents fall back to the owner's account only with the owner's explicit instruction, and the ruleset's code-owner review then has no second identity to gate.
