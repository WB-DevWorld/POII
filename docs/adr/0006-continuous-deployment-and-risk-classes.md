# ADR-0006 Continuous deployment with path-based risk classes

Status: accepted · 2026-10-09 · Applies the owner's ND-4 amendment and the release policy approved with the build commission. Later changes to the policy are gated.

## Decision

- Every change is a PR with required CI. Routine PRs auto-merge when green; gated PRs wait for the owner.
- The risk class is computed by the `risk-classify` workflow from the changed paths against `.github/release-policy/risk-classes.json` on the base branch, never the PR's own copy. Labels can raise, never lower. Unclassifiable changes are gated.
- On merge, immutable images are published to GHCR tagged with the SHA and identified by digest. Staging deploys that digest automatically (M2). Routine changes promote the same digest to production automatically once staging checks pass; gated changes go through the `production-gated` environment with the owner as required reviewer.
- The first production activation needs the owner's activation phrase. Until a bot identity exists, agents act through the owner's account, gated items wait for the owner's phrase in chat, and agents never call approval or bypass endpoints.
- Secret scanning runs as gitleaks over the full history in CI plus GitHub push protection; dependency review, Dependabot and CodeQL run on every PR.

## Consequences

The repository is public; private evidence never enters it. Deploy credentials live only in GitHub environments and Dokploy. The previous digest is kept for one-step rollback; database restore is a separate runbook.
