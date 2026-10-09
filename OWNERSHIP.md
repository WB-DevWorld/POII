# Ownership

One writable master per record. Everything else is a reference or a rebuildable projection.

| Truth | Master |
| --- | --- |
| POII code, specifications, ADRs, baseline, release policy | Git (`WB-DevWorld/POII`) |
| Decisions, evidence, notes and approvals recorded in POII | POII's PostgreSQL database |
| Other projects' code, tasks, product data and identity | Their own systems; POII stores references, observations and rationale |
| Credentials, OIDC sessions, `iss`/`sub`, durable person id | AccessLobby (connected deployments); the local identity adapter (standalone) |
| MindMesh's ordinary memories and model routing | MindMesh; shared records move only by explicit copy or promotion with origin, version, conflict and deletion rules |
| Normative rules | ADSCIS/USCR |
| Capability registry | MeshCore |
| Current-state views, context packs, search indexes, vectors | Rebuildable projections of POII's database, never edited directly |

KnowledgeMesh is absorbed into POII. ResearchFlow stays a separate, deeply integrated peer. Neither MindMesh nor POII is a runtime dependency of the other.

Private evidence (the owner's conversations and documents) stays outside Git, in the owner's private POII instance.

Cross-product relationships use versioned contracts and local references; no cross-database foreign keys.
