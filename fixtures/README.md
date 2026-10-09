# Acceptance fixtures

Fictional material used by the acceptance tests (BUILD-BASELINE.md §8). Nothing here is real evidence. Each fixture is loaded as a source; the tests then create, confirm and supersede records against exact spans and check the current-decisions view, search, exports and restore.

| Fixture | Exercises |
| --- | --- |
| `decision-chain.md` | Pasted assistant text that is **not** the owner's statement; an owner decision; a later supersession; an instruction hidden in the source that must never execute. |
| `intent-vs-observed.md` | A designed limit (intent) and a deployment log (observation) that disagree; both are recorded and shown. |
| `price-conflict.md` | Two conflicting product prices from different sources, a missing date on one, and the approval that settles it, by whom. |

The project, company, people and prices in these files are invented.
