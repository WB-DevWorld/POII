# ADR-0008 Search and the versioned context-pack format

Status: accepted · 2026-10-09 · The export format is a gated class.

## Decision

- Search is PostgreSQL full-text first: generated `tsvector` columns on source revisions and records, GIN indexes, `websearch_to_tsquery`, ranked results with headline snippets that resolve to exact spans. No vector store in release one; when added, vectors are a rebuildable projection.
- A context pack is produced in two formats from one manifest: Markdown for people and agents, JSON for programs. The JSON carries `format: "poii.context-pack"` and `formatVersion: 1`. Adding optional fields is non-breaking; changing meaning or removing fields bumps the version and keeps the previous exporter for one release.
- Every pack lists, with reasons, the sources it **included**, **excluded** (archived, never-send-to-AI when the pack is destined for AI, filtered out) and **unavailable** (deleted, revision lost). Every item cites `sourceId`, `revisionId`, offsets and the excerpt hash so a reader can verify the citation.
- The pack shows attribution and approval separately, the lifecycle status, the three times with their statuses, supersession links, and the pack's own generation time and the staleness of each item (last observed time or `unknown`).
- A backup is a different artifact: `poii.backup` version 1, the complete workspace (sources, revisions, records, versions, evidence, approvals, audit events, tombstones) plus originals from storage, restorable into an empty install with identical ids.

## Consequences

Exports can be regenerated at any time and are never edited by hand. Deleted material appears only as an "unavailable" entry.
