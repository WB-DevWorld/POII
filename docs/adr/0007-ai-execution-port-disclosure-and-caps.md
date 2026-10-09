# ADR-0007 AI-execution port, per-action disclosure and hard caps

Status: accepted · 2026-10-09 · Applies ND-1 (optional AI), ND-3 (information policy) and the owner's provider and cap decisions. Provider, cap and disclosure code are gated classes.

## Decision

- One AI-execution port (`apps/api/src/ports/ai-execution.ts`): `extractCandidates(request)` and later operations. Adapters: `anthropic`, `openai`, `off`. `off` is the default; the manual journey never depends on the port.
- Every AI action is a two-step call: `preview` returns exactly the text that would be sent, the provider, the model and the estimated cost; `execute` sends only what the preview showed, bound by a preview id that expires.
- Sources with `ai_allowed = false`, and records derived from them, are rejected by the port before any provider client is constructed. Request logs store a hash of the prompt and the record ids, never the prompt text of a disallowed source; allowed prompt text is stored only when the owner enables request-text logging.
- Hard caps are enforced inside POII per provider per calendar month (USD 20 each, configured by environment), on top of provider-side limits. Usage is estimated before the call and reconciled from the provider's reported usage after it. At the cap, `execute` fails with `cap_reached` and the UI offers the manual path.
- AI output becomes candidates with `statement_mode = ai_extracted` and `stated_by` the AI actor for that provider and model. Nothing an AI returns is confirmed automatically. Text inside sources or provider responses is never executed as an instruction.
- Connected deployments can route the same port through MindMesh when it exists; neither product becomes a runtime dependency of the other.

## Consequences

Switching providers or adding MindMesh changes an adapter, not the product. The compatibility matrix records what was actually tested per provider.
