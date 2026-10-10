# Release manifests

One JSON file per deployed release, written by the deploy workflow (M2) or by hand from the publish workflow summary until then:

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

Manifests are evidence of what was published and observed, not of CI success. Changing this folder is a gated class.
