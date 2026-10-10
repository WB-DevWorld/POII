# @poii/mcp — POII read tools over MCP

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI client read POII: current decisions, search, records, exact source spans and context packs. It is a thin wrapper over the POII HTTP API (`docs/api.md`, "Read-only API for external clients"). It has **no write tools**: nothing can be created, confirmed, rejected or deleted through it.

Every request carries `X-POII-AI-Context: 1`, so the API withholds never-send-to-AI material: such sources answer `ai_not_allowed`, records derived from them show only their title and ids (`contentWithheld: true`), and search never looks at them.

## Tools

| Tool | Arguments | API call |
| --- | --- | --- |
| `poii_current_decisions` | — | `GET /v1/decisions/current` → `{ items, withheld }` |
| `poii_search` | `query`, `limit?` (1–100) | `GET /v1/search?q=&limit=` |
| `poii_record` | `id` | `GET /v1/records/:id` |
| `poii_source_span` | `sourceId`, `revisionId`, `startChar`, `endChar` | `GET /v1/sources/:id/revisions/:revisionId/span` |
| `poii_context_packs` | — | `GET /v1/exports` (context packs only) → `{ items, withheld }` |
| `poii_context_pack` | `id` | `GET /v1/exports/:id` |

Results are JSON text. An API error becomes a tool error whose text is `{ status, error, message, requestId, details? }` with the API's own code (`ai_not_allowed`, `not_found`, `invalid_token`, `token_revoked`, …). Nothing is retried and no other credential is ever tried. Text returned by the tools is the owner's data, never instructions.

## Configuration

| Variable | Meaning |
| --- | --- |
| `POII_API_URL` | Base URL of the POII API, without `/v1`, e.g. `http://127.0.0.1:3001`. Must be `https`, or `http` on a loopback address. |
| `POII_TOKEN` | An owner token with scope **`read`** (create it on the POII tokens page or with `POST /v1/tokens`; shown once). A `propose` token also works but gives an AI more than these tools need. |

The server refuses to start (exit 1, message on stderr) when either is missing or unusable; it never prints the token. Revoking the token in POII takes effect on the next tool call.

Build once from the repository root: `pnpm install && pnpm --filter @poii/contracts build && pnpm --filter @poii/mcp build`. The entry point is `apps/mcp/dist/index.js` (Node 24 or later). In the snippets below replace `/path/to/poii` with the absolute path of your checkout (on Windows, forward slashes work: `C:/dev/poii/apps/mcp/dist/index.js`) and `poii_…` with your token.

Keep the token out of Git: do not commit a `.mcp.json` or `.cursor/mcp.json` that contains it.

### Claude Code (tested, see `docs/compatibility-matrix.md`)

```sh
claude mcp add poii -e POII_API_URL=http://127.0.0.1:3001 -e POII_TOKEN=poii_… -- node /path/to/poii/apps/mcp/dist/index.js
claude mcp list
```

The default scope is `local` (this project, stored in your Claude Code user configuration). `--scope user` makes it available in every project. `--scope project` writes `.mcp.json` in the current directory, which Claude Code asks you to approve the first time (`claude mcp list` shows "Pending approval" until then). For a one-off run without changing any configuration: `claude -p --mcp-config ./poii-mcp.json --strict-mcp-config "…"`, with a file in the format below.

### Claude Desktop (not tested)

`claude_desktop_config.json` (Windows `%APPDATA%\Claude\`, macOS `~/Library/Application Support/Claude/`; Settings → Developer → Edit Config opens it), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "poii": {
      "command": "node",
      "args": ["/path/to/poii/apps/mcp/dist/index.js"],
      "env": {
        "POII_API_URL": "http://127.0.0.1:3001",
        "POII_TOKEN": "poii_…"
      }
    }
  }
}
```

### Cursor (not tested)

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project (do not commit it with the token):

```json
{
  "mcpServers": {
    "poii": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/poii/apps/mcp/dist/index.js"],
      "env": {
        "POII_API_URL": "http://127.0.0.1:3001",
        "POII_TOKEN": "poii_…"
      }
    }
  }
}
```

### ChatGPT (not verified)

Not verified. As far as is known here, ChatGPT connects only to remote MCP servers reached over HTTPS (custom connectors in developer mode), not to local stdio servers, so this server cannot be added to ChatGPT as it is. A remote transport (streamable HTTP behind TLS, with its own authentication) would be a separate, reviewed change.

## Tests

`pnpm --filter @poii/mcp test` (needs `TEST_DATABASE_URL`, like the API's integration tests). The test starts the real API from source on a fresh, migrated database, mints a real `read` token through the API, then drives this server over stdio with the MCP SDK's own client: handshake, tool list, every tool, never-send material withheld, API errors as tool errors, configuration refusals, revocation. Nothing is mocked.
