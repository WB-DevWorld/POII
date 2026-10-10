# Live environment facts

Observed deployments only, by digest, with the time of observation. CI success is recorded in `CURRENT-WORK.md`, not here.

## 2026-10-10

- No staging or production deployment exists. No Dokploy project, backup target or AccessLobby client registration exists for POII yet.
- Immutable images were published for every merge to `main` observed today: [run 38017613639](https://github.com/WB-DevWorld/POII/actions/runs/38017613639) for `74af208e24edbb5cdca5ae5d62e2e7f888365b2e` (PR #26), [run 38018859427](https://github.com/WB-DevWorld/POII/actions/runs/38018859427) for `ee295683f54912d76c0d68f7f1168a603840e727` (PR #27), [run 38019515122](https://github.com/WB-DevWorld/POII/actions/runs/38019515122) for `5b4459292b91fc87edeb90386bd7d7723ad7225c` (PR #29). Tags `ghcr.io/wb-devworld/poii-api:sha-<sha>` and `poii-web:sha-<sha>`; digests in each run summary. No publish run exists for `96119b1` (PR #28). The packages stay private on GHCR.
- The GitHub App `wbdevworld-poii-agent` is installed on this repository (installation 169805354); agent commits and PRs are authored by it from today.

## 2026-10-09

- No staging or production deployment exists.
- First immutable images were published by [publish run 37996328909](https://github.com/WB-DevWorld/POII/actions/runs/37996328909) for source `df73e83eaabb3739e5d5d366ec6f33fd4cfebe02` (PR #10 merge): `ghcr.io/wb-devworld/poii-api:sha-df73e83…` and `ghcr.io/wb-devworld/poii-web:sha-df73e83…`. The digests are in that run's summary. The packages are private on GHCR (organization default); reading them needs `read:packages`, so the agent could not inspect the manifests from this machine. Dokploy will need the GHCR pull credentials from the owner setup list.
- `WB-DevWorld/POII` is public. It was empty (no branches) until the M0 seed commit on 2026-10-09.
- No backup target, Dokploy project or AccessLobby client registration exists for POII yet.
