# Claude Code hook capture (opt-in)

`scripts/poii-hook.mjs` is a [Claude Code hook](https://code.claude.com/docs/en/hooks) that captures a Claude Code session's prompts and final answers as one POII **source**. It only proposes: it never creates records or approvals, and the owner token it uses cannot confirm anything. It is opt-in per project, and it never blocks Claude Code. Issue #21; BUILD-BASELINE.md §4.3.

Node 24, no dependencies. The script reads the hook event JSON on stdin. It never prints the token or any captured text.

## What is captured and what is not

| Transcript content | Captured? | Notes |
| --- | --- | --- |
| Prompts the user typed (`type: user`, plain text, `origin.kind: human` / `turnOrigin: human` where present) | **Yes**, if `capture` has `"prompts"` | Text blocks only; images and other blocks are dropped. |
| The assistant's final answer to each typed prompt | **Yes**, if `capture` has `"answers"` | The text of the last assistant message before the next prompt, if that message made no tool call. On `Stop`, the event's `last_assistant_message` is used for the last turn when the transcript has not caught up yet. |
| Assistant text written before or between tool calls ("Let me read the file.") | No | Not a final answer. |
| Tool calls and their inputs (`tool_use`) | No | |
| Tool results and output, including file contents read by a tool (`tool_result`) | No | |
| Thinking blocks | No | |
| Attachments, file-history snapshots, queue operations, titles, PR links, `system` lines | No | |
| Meta lines (`isMeta`), slash-command echoes (`<command-name>`, `<local-command-stdout>`, ...), `<system-reminder>` | No | |
| Task notifications, subagent hand-backs and the assistant's replies to them | No | A turn not started by the user is skipped up to the next typed prompt. |
| Subagent (sidechain) messages | No | |
| Compact summaries | No | |
| Any line that looks like a secret (table below) or matches a project `redact` pattern | **No: withheld** | The whole line is replaced by `[withheld by the POII hook: line matched <pattern name>]`. The value is never sent. A private-key block is withheld from `BEGIN` to `END`. |
| The transcript path, the full working directory, the git branch, model and permission settings | No | Only the **basename** of the project directory is sent. |

Built-in redaction patterns (a matching line is withheld): `anthropic-key` (`sk-ant-…`), `openai-key` (`sk-…`, `sk-proj-…`), `poii-token` (`poii_…`), `github-token` (`ghp_…`, `gho_…`, `ghs_…`, `ghu_…`, `ghr_…`, `github_pat_…`), `aws-access-key` (`AKIA…`, `ASIA…`), `google-api-key` (`AIza…`), `slack-token` (`xox?-…`), `stripe-key` (`sk_live_…`, `rk_test_…`), `jwt`, `bearer-credential` (`Bearer <16+ chars>`), `url-with-password` (`scheme://user:password@`), `private-key` (`-----BEGIN … PRIVATE KEY-----`), and `secret-assignment`: a name containing password, passwd, pwd, secret, api key, access key, auth token, token, private key or client secret, followed by `:` or `=` and a value of 8 or more characters. Redaction is a safety net, not a guarantee: keep secrets out of prompts.

## The opt-in file: `.poii/capture.json`

The hook does nothing unless the project directory has `.poii/capture.json` with `"enabled": true`. Without the file it exits 0 silently. The project directory is `CLAUDE_PROJECT_DIR`, or the event's `cwd` when that is unset. An invalid file means nothing is sent, and the reason goes to stderr.

```json
{
  "enabled": true,
  "events": ["Stop"],
  "capture": ["prompts", "answers"],
  "redact": ["LNT-[0-9]{6}"],
  "aiAllowed": false,
  "envFile": ".poii/capture.env.local"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | none (required) | Must be `true`; anything else means off. |
| `events` | `["Stop"]` | Which hook events capture: `Stop`, `SessionEnd` or both. An event not listed is ignored. |
| `capture` | `["prompts", "answers"]` | Which side to capture. Must not be empty. |
| `redact` | `[]` | Extra regular expressions (JavaScript syntax, case-insensitive). A line matching one is withheld. An invalid pattern disables capture: the hook fails closed. |
| `aiAllowed` | `false` | The source's "may be sent to AI" flag. Default **false**: only the owner can turn it on later in POII. |
| `envFile` | none | A `KEY=VALUE` file (relative to the project or absolute) from which only `POII_API_URL` and `POII_TOKEN` are read, when they are not in the environment. |

`fixtures/claude-code/capture.json` is this example.

**Privacy.** Commit `.poii/capture.json` only if everyone working in the repository agrees that their Claude Code sessions in it may be captured. Otherwise keep it untracked (add `.poii/` to `.git/info/exclude` or `.gitignore`). Never commit the env file or the token.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `POII_API_URL` | yes | POII API base URL, without `/v1` (a trailing `/v1` is stripped). `https` is required; plain `http` only for `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`. |
| `POII_TOKEN` | yes | An owner token (`poii_…`) with scope **`propose`**. |
| `POII_HOOK_TIMEOUT_MS` | no | Total time budget. Default **10000** ms; minimum 500, maximum 60000. |
| `POII_HOOK_DEBUG` | no | `1` logs why nothing was sent, for example "not enabled". |

The process environment wins over `envFile`.

**Token.** The owner creates the token on the Tokens page or with `POST /v1/tokens` `{ "name": "Claude Code hook", "scopes": ["propose"], "expiresAt": "<at most 366 days ahead>" }` (docs/api.md, ADR-0009). With `propose` the hook can create sources, revisions and actors. Like every owner token, it gets `403 authority_required` on confirm, reject, delete, restore, backup and `aiAllowed` changes. A `read` token gets `403 scope_required` and nothing is stored. Revoke the token to stop every capture immediately.

## Registering the hook

Hooks are configured in Claude Code's settings (`hooks` → event → matcher group → handlers). Put this in the project's `.claude/settings.local.json` (not committed) or in `~/.claude/settings.json`. Registering at user level is safe: the hook still does nothing in a project without `.poii/capture.json`.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/poii/scripts/poii-hook.mjs\"",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

On Windows use forward slashes in the path, for example `node \"C:/dev/poii/scripts/poii-hook.mjs\"`.

**Why `Stop`.** `Stop` runs each time the main agent finishes responding. It carries `session_id`, `transcript_path`, `cwd` and `last_assistant_message`. Claude Code's docs warn that the transcript may not yet contain the final message at `Stop` time, so the hook uses `last_assistant_message` for the last turn. With `"async": true` the hook runs in the background and Claude Code never waits for it. The hook always exits 0 and never exits 2, so it cannot keep Claude working. `Stop` does not run when the user interrupts; the next `Stop` or `SessionEnd` picks the turn up.

**`SessionEnd` instead.** To get one capture per session instead of one per turn, list `"SessionEnd"` in `events` and register the same command under `SessionEnd`. SessionEnd hooks share a default 1.5-second budget. A per-hook `"timeout"` (for example `15`) raises it, up to 60 seconds; so does `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. A crash or kill without a clean session end captures nothing. Both events can be enabled together.

In `claude -p` (non-interactive) mode Claude Code kills async hooks still running at teardown, so the last turn can be missed there.

## What is sent

1. `GET /v1/actors`, and `POST /v1/actors` `{ kind: "ai_assistant", displayName: "Claude Code (hook)" }` once, if that actor does not exist yet. This is skipped when `capture` has no `"answers"`.
2. `POST /v1/sources`:
   - `kind`: `"paste"` (as for pasted conversations)
   - `mediaType`: `"text/plain"`
   - `title`: `Claude Code session <first 8 of the session id> (<project basename>)`
   - `aiAllowed`: from the file (default `false`)
   - `originKey`: `"claude-code:<sessionId>"`
   - `content`: a short header, then each captured message under a heading such as `--- 3 · user prompt · 2026-10-09T08:01:00.000Z ---`. A message without a timestamp shows `time unknown`.
   - `origin`:
     ```json
     {
       "importedFrom": "claude-code-hook",
       "hookVersion": 1,
       "sessionId": "<session id>",
       "cwd": "<project directory basename only>",
       "capturedAt": "<ISO time of this capture>",
       "hookEvent": "Stop",
       "captured": ["prompts", "answers"],
       "attribution": {
         "assistant": { "actorKind": "ai_assistant", "actorName": "Claude Code (hook)", "actorId": "<id or null>" },
         "user": { "statedRole": "unknown", "note": "Prompts become the owner's own words only when the owner confirms a record citing them." }
       },
       "messages": [
         { "index": 1, "role": "user", "timestamp": "…", "startChar": 288, "endChar": 358 },
         { "index": 2, "role": "assistant", "timestamp": "…", "startChar": 437, "endChar": 543 }
       ],
       "redaction": { "withheldLines": 5, "patterns": ["anthropic-key", "project-pattern-1"] }
     }
     ```
     `messages[].startChar`/`endChar` are UTF-16 offsets of each message's text in the revision the source was created with, the same unit as evidence locators. Only names of redaction patterns are recorded, never values.
3. If the API answers `deduplicated: true` for the same origin key, the hook sends `POST /v1/sources/:id/revisions` with the new content and a note such as `claude-code-hook: 6 messages, 5 lines withheld`.

**Idempotency.** The source is identified by `(workspace, originKey)`.
- **Unchanged transcript:** the content is identical, because it is built deterministically and `capturedAt` lives only in `origin`, so the revision call is a no-op (200).
- **Longer transcript:** becomes a new revision.
- **Late, shorter capture:** if the stored revision is already longer, no revision is added. This happens when async hooks finish out of order.
- **Content matching another source:** if the API returns a source with a *different* origin key (same content hash), the hook adds nothing to it.
- **`origin` updates:** `origin` is set when the source is created and is not updated by later revisions. Per-message offsets for a later revision can be found from the headings in its text.

**Attribution.** The hook creates no records, so it attributes nothing by itself.
- **Assistant answers:** when the owner (or a propose token) later creates a candidate from an answer span, it cites the `ai_assistant` actor "Claude Code (hook)" with `statedRole: assistant`.
- **The user's prompts:** they become the owner's own words only when the owner creates or confirms a record with `statedRole: owner`. The hook never asserts that.

## Timeout and failure behaviour

Every request carries the remaining time budget (`POII_HOOK_TIMEOUT_MS`, default 10 s) as its abort signal. A last-resort guard stops the process 0.5 s after the budget. Every failure is logged to stderr with the prefix `[poii-hook]`, and the exit code is always 0. Failures include an unreachable or slow API, a refused token, an invalid file, a missing transcript, a transcript over 100 MB, or captured text over 5,000,000 characters. Exit 0 is success for Claude Code, so a capture failure never interrupts the session. Set the settings `timeout` (in seconds) above the hook's own budget, for example 15 for the default 10 s.

## Removing it

1. Delete the hook entry from the Claude Code settings file.
2. Delete `.poii/capture.json`, or set `"enabled": false`. Either alone stops capture for that project.
3. Revoke the token (Tokens page, or `DELETE /v1/tokens/:id`). Capture stops everywhere at once.
4. Optionally, the owner deletes captured sources in POII (`DELETE /v1/sources/:id`, owner only). They are found by `originKey` prefix `claude-code:` or `origin.importedFrom = claude-code-hook`.

## Tests

`infra/scripts/poii-hook.test.mjs` runs in CI's release-policy step and with `pnpm policy:check`. It uses fictional transcripts from `fixtures/claude-code/`; secret-like values are generated at run time.
- **Mocked suite:** the API is a **MOCKED** in-process stub.
- **Real-API suite:** runs against a real API when `POII_HOOK_TEST_API_URL` points at one with the `local-owner` adapter. The test mints its own `propose` token.
