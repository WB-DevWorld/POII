# Release manifests

One JSON file per deployed release. The deploy workflows write it to the run summary and upload it as an artifact; it is recorded here through a normal PR.

## Staging

Written by `deploy-staging.yml`. File name: `staging-<UTC yyyymmddThhmmssZ>-<first 12 characters of the SHA>.json`.

```json
{
  "sourceSha": "<40-hex>",
  "api": "ghcr.io/wb-devworld/poii-api@sha256:<digest>",
  "web": "ghcr.io/wb-devworld/poii-web@sha256:<digest>",
  "environment": "staging",
  "deployedAt": "<ISO time>",
  "observedReadyVersion": "<SHA reported by /health/ready>",
  "previous": "<file name of the previous manifest for one-step rollback>"
}
```

## Production

Written by `deploy-production.yml` (ADR-0013). No production manifest exists yet: production has never been deployed. File name: `production-<UTC yyyymmddThhmmssZ>-<first 12 characters of the SHA>.json`. Same fields as staging, with `environment: "production"`, and two more:

```json
{
  "sourceSha": "<40-hex>",
  "api": "ghcr.io/wb-devworld/poii-api@sha256:<digest>",
  "web": "ghcr.io/wb-devworld/poii-web@sha256:<digest>",
  "environment": "production",
  "deployedAt": "<ISO time>",
  "observedReadyVersion": "<SHA reported by /health/ready on the production host>",
  "previous": "<file name of the previous production manifest, or null on the first deploy>",
  "promotedFrom": "<file name of the staging manifest this release was promoted from>",
  "promotionClass": "routine | gated"
}
```

- `api` and `web` are the digests from the staging manifest named by `promotedFrom`; nothing is rebuilt for production.
- `previous` names the last production deploy that passed every check. It is taken from that run's manifest artifact; if the artifact is gone, from the newest `production-*.json` recorded here.
- `promotionClass` is `routine` when every commit since `previous` came in through a merged pull request labelled `risk:routine`. Otherwise it is `gated`, and the deploy waited for the owner's approval in the `production-gated` environment. The first deploy is always `gated`.
- The staging manifest named by `promotedFrom` may not be recorded in this folder yet; the workflow reads it from the staging run's artifact.

Manifests are evidence of what was published and observed, not of CI success. Changing this folder is a gated class.
