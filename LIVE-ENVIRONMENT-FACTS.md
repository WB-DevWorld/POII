# Live environment facts

Observed deployments only, by digest, with the time of observation. CI success is recorded in `CURRENT-WORK.md`, not here.

## 2026-10-09

- No staging or production deployment exists.
- First immutable images were published by [publish run 37996328909](https://github.com/WB-DevWorld/POII/actions/runs/37996328909) for source `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02` (PR #10 merge): `ghcr.io/wb-devworld/poii-api:sha-df73e83…` and `ghcr.io/wb-devworld/poii-web:sha-df73e83…`. The digests are in that run's summary. The packages are private on GHCR (organization default); reading them needs `read:packages`, so the agent could not inspect the manifests from this machine. Dokploy will need the GHCR pull credentials from the owner setup list.
- `WB-DevWorld/POII` is public. It was empty (no branches) until the M0 seed commit on 2026-10-09.
- No backup target, Dokploy project or AccessLobby client registration exists for POII yet.
