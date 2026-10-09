# Owner setup tasks

Only the owner can do these. Each step is short and exact. Keys go into the local `.env` (gitignored) and into GitHub or Dokploy secrets; never paste a key into chat, an issue or a PR.

## 1. Local machine (once)

1. **pnpm.** A stale `pnpm.exe` shim in the nvm shim folder shadows the real pnpm. Either delete `%LOCALAPPDATA%\Author Software\nvm\.nodejs\pnpm.exe`, or move `%APPDATA%\npm` above the nvm folders in the user PATH. Then open a new terminal and run `pnpm --version` (expect 11.19.0).
2. **Node.** Node 25 is first on PATH; CI and images use Node 24 LTS. Optional: run `nvm use 24.21.0` in the terminal you build in. Node 25 works for local development.
3. Everything else is present: Git, Docker Desktop with WSL2, GitHub CLI signed in as the organization owner.

## 2. Bot identity for agent PRs

Choose one:

- **GitHub App (recommended).** Organization settings → Developer settings → GitHub Apps → New GitHub App. Name `poii-agent`, no webhook, permissions: Contents read/write, Pull requests read/write, Issues read/write, Workflows read/write, Metadata read. Install it on `WB-DevWorld/POII` only. Generate a private key, store it as repository secrets `POII_AGENT_APP_ID` and `POII_AGENT_APP_PRIVATE_KEY`.
- **Alternative.** A separate machine-user account invited to the organization with write access to POII only, with a fine-grained PAT.

Until this exists, agents commit through your account and gated items wait for your approval phrase in chat.

## 3. Anthropic Console

1. Claim the Max plan's monthly API credits in the Console billing page.
2. Create a key named `poii-staging`, set a monthly spend limit of USD 20, scope it to a `POII` workspace if workspaces are available.
3. Put it in local `.env` as `ANTHROPIC_API_KEY` and in the Dokploy staging environment as the same name.

## 4. OpenAI

1. Create a project `POII`, set a monthly budget of USD 20 with a hard limit.
2. Create a project key `poii-staging`.
3. Put it in local `.env` as `OPENAI_API_KEY` and in the Dokploy staging environment.

## 5. Dokploy on the existing Hetzner capacity

1. Create project `POII` with environments `staging` and `production`.
2. Create a Compose service per environment from `compose.dokploy.yaml` (Isolated Deployment off), pointing at this repository.
3. Create an API token scoped to the POII project; store it as the GitHub environment secret `DOKPLOY_TOKEN` for `staging` and the Dokploy URL as `DOKPLOY_URL`.
4. Add GHCR pull credentials in Dokploy (a read-only PAT with `read:packages`) so the images can be pulled.
5. Domains: `poii-staging.<your domain>` and `poii.<your domain>` on the same server, HTTPS via Dokploy's Domains tab. Tell the agent the exact hostnames.

## 6. Backup target

1. Provide the existing backup target (S3-compatible endpoint, bucket, access key, secret) as Dokploy environment variables `POII_BACKUP_S3_ENDPOINT`, `POII_BACKUP_S3_BUCKET`, `POII_BACKUP_S3_ACCESS_KEY`, `POII_BACKUP_S3_SECRET_KEY`.
2. The restore drill runs against staging before production activation.

## 7. GitHub repository settings (one-time, done by the agent on your account)

The agent sets: squash-only merges, delete branch on merge, auto-merge allowed, secret-scanning push protection, Dependabot alerts, the `main` ruleset requiring the CI checks, and the `production-gated` environment with you as required reviewer. Review them under Settings → Rules and Settings → Environments.

## 8. AccessLobby client registration (M3)

The agent prepares the exact client request (callback, logout and backchannel URLs, PKCE, audience). You approve it in AccessLobby; the agent never changes AccessLobby.
