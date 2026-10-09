# ADR-0001 Ownership: one writable master per record

Status: accepted · 2026-10-09 · Applies the owner's ND-3 decision with its MindMesh amendment.

## Context

POII sits among peers (AccessLobby, MindMesh, ResearchFlow, MeshCore, ADSCIS/USCR, DonLoft) and other AI tools. Two writable copies of the same record produced the drift this product exists to prevent.

## Decision

- Git (`WB-DevWorld/POII`) is the master of POII's code, specifications, ADRs, baseline and release policy.
- POII's PostgreSQL database is the master of decisions, evidence, notes and approvals recorded in POII.
- Other systems are the masters of their own records; POII stores references, observations and rationale, never a writable copy.
- Views, context packs, search indexes and vectors are rebuildable projections and are never edited directly.
- KnowledgeMesh is absorbed into POII. ResearchFlow stays a separate, deeply integrated peer. ADSCIS/USCR keeps normative rules. MeshCore keeps the capability registry.
- MindMesh keeps its own ordinary memories and runs without POII. POII runs without MindMesh. Shared records move only by explicit copy or promotion, carrying origin system, origin id, origin version, a conflict rule (origin wins unless promoted) and a deletion rule (deletion in the origin marks the copy unavailable; it does not silently delete a promoted record).
- Private evidence stays outside Git, in the owner's private instance.

## Consequences

Every record in POII carries `origin` metadata from the first migration. There are no cross-database foreign keys. Exports always say which system is the master of each item.
