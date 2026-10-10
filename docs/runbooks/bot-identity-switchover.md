# Bot identity switch-over

Prepared on 2026-10-10 as part of the gate-hardening PR. **Nothing here is applied yet.** The owner applies steps 1 to 4 once the bot identity exists; an agent never runs them. Each step is one command or one screen. Replace values in angle brackets.

## Why

Today agents commit and open PRs through the owner's account, so an approval by the owner on GitHub would approve the owner's own PR. Once a separate bot identity opens the PRs, the owner's review on GitHub becomes a real gate and the ruleset can require it.

## 1. Create the GitHub App (owner, once)

1. GitHub → the `WB-DevWorld` organisation → Settings → Developer settings → GitHub Apps → New GitHub App.
   - Name: `poii-agent`. Homepage: the repository URL. Webhook: inactive.
   - Repository permissions: Contents read and write, Pull requests read and write, Issues read and write, Workflows read and write, Metadata read.
   - Where can this App be installed: only this account.
2. Create the App, note the **App ID**, then "Generate a private key" and save the `.pem` file **outside** every repository, for example `%USERPROFILE%\.poii\poii-agent.pem`.
3. Install the App: App settings → Install App → `WB-DevWorld` → "Only select repositories" → `POII`.
4. Find the bot's user id (needed for commit attribution):

```bash
gh api "/users/poii-agent%5Bbot%5D" --jq .id
```

## 2. Agents commit and open PRs as the bot

Done by the agent in `C:\dev\poii` (and every worktree, which shares the same config) once the owner says the App exists. No change to history.

1. Environment for the agent's shell, set by the owner (the PEM path only, never the key contents, never in chat):

```bash
export POII_AGENT_APP_ID=<app id>
export POII_AGENT_APP_PRIVATE_KEY_FILE="$USERPROFILE/.poii/poii-agent.pem"
```

2. Commit identity (repo-local, replaces the owner's noreply identity):

```bash
git -C C:/dev/poii config user.name "poii-agent[bot]"
git -C C:/dev/poii config user.email "<bot user id>+poii-agent[bot]@users.noreply.github.com"
```

3. Pushing and `gh` calls use a one-hour installation token minted by `infra/scripts/agent-token.mjs` (no dependencies). Before each session or when a push is rejected:

```bash
node infra/scripts/agent-token.mjs | gh auth login --with-token --hostname github.com
gh auth setup-git
```

   `gh auth status` should then show `poii-agent[bot]`. The owner's own `gh` login is kept as a separate account (`gh auth switch` returns to it).

4. From then on every PR, label change and comment by an agent is attributed to `poii-agent[bot]`. The owner reviews and approves on GitHub; the chat phrase stays as the record in `CURRENT-WORK.md`.

## 3. Ruleset: require code-owner review

Prepared file: `infra/github/ruleset-protect-main.bot.json` (the current "Protect main" ruleset with `require_code_owner_review: true`, `required_approving_review_count: 1`, `require_last_push_approval: true`; everything else unchanged). Apply:

```bash
gh api -X PUT repos/WB-DevWorld/POII/rulesets/24817305 --input infra/github/ruleset-protect-main.bot.json
```

Check: `gh api repos/WB-DevWorld/POII/rulesets/24817305 --jq '.rules[] | select(.type=="pull_request") | .parameters'` shows the three values above. From now on a PR that touches a `CODEOWNERS` path needs the owner's GitHub approval, and a PR from the bot needs one approving review from someone other than its author (the bot cannot approve).

Consequence to accept: routine PRs no longer auto-merge without one approving review. If that is too slow for routine work, keep `required_approving_review_count` at 0 and only `require_code_owner_review: true` (edit the JSON before applying); code-owner review then applies only to the protected paths.

## 4. Environment: prevent self-review on `production-gated`

Prepared file: `infra/github/environment-production-gated.bot.json`. Apply:

```bash
gh api -X PUT repos/WB-DevWorld/POII/environments/production-gated --input infra/github/environment-production-gated.bot.json
```

Check: `gh api repos/WB-DevWorld/POII/environments/production-gated --jq '.protection_rules[] | select(.type=="required_reviewers") | .prevent_self_review'` prints `true`.

## 5. Afterwards (optional, agent PR, gated)

Change `.github/workflows/risk-classify.yml` so the `classify` check fails for a gated PR until an approving review by the owner exists on the PR. Then the chat phrase is a record and the GitHub review is the technical gate. This is a separate gated PR after steps 1 to 4 are confirmed working.

## Verification after the switch-over

1. The agent opens a trivial routine PR: author shows as `poii-agent[bot]`; the PR waits for review if step 3 requires one.
2. The agent opens a PR touching `.github/release-policy/sensitive-areas.json`: GitHub requests review from `@wbdevworld`; the merge button stays blocked until the owner approves.
3. `docs/release-policy.md` section "What is enforced today" is updated in the same PR that records the switch-over in `CURRENT-WORK.md`.
