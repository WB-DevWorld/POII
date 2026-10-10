# Conversation import (M3, issue #20)

The owner can import **selected** conversations (never a bulk import of all past chats, BUILD-BASELINE.md §3) from the official data exports of ChatGPT and Claude.ai. Each selected conversation becomes one immutable POII source with per-message attribution and timestamps. The import creates sources only: never records, never approvals. HTTP details: [api.md](api.md#conversation-import-m3-20). Web: `/imports`.

## Supported export formats

Both exports are ZIP archives containing a `conversations.json`. The owner unzips the archive and chooses that file. Shapes are those observed in 2026 exports; unknown extra fields are ignored, but the fields below must be present with these types or the whole file is refused (`400 unsupported_export`, with up to ten `{ path, message }` issues and never any message text).

**ChatGPT** (`importedFrom: chatgpt-export`): a JSON array of conversations `{ title, create_time, update_time, mapping, current_node, conversation_id | id }`. `mapping` is a tree of nodes `{ id, message | null, parent, children[] }`; a message has `author.role` (`user`, `assistant`, `system`, `tool`), `create_time` (epoch seconds, may be null), `content.content_type` and `content.parts[]` (or `content.text`), `recipient`, `metadata.is_visually_hidden_from_conversation`.

**Claude.ai** (`importedFrom: claude-export`): a JSON array of conversations `{ uuid, name, created_at, updated_at, chat_messages[] }`; a message is `{ uuid, sender: 'human' | 'assistant', created_at (ISO 8601), text, content[], attachments[], files[] }`. Any other `sender` is refused.

The provider is recognised from the first conversation (`mapping` → ChatGPT, `chat_messages` → Claude.ai); every conversation must then match that provider's shape. Also refused: a file that is not an array, an empty array, conversation ids outside `[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}`, the same id twice, and a ChatGPT tree with a cycle.

## Which messages are imported

- **ChatGPT linearisation.** A ChatGPT conversation is a tree: editing a message or regenerating an answer creates a branch. The importer follows the **current branch**: from `current_node` up the `parent` links to the root, then reversed (root first). Messages on other branches are not imported; the preview counts them (`otherBranchMessageCount`). If `current_node` is missing or unknown, it takes the latest leaf (from the single root, always the last child) and the rendering says so.
- **Claude.ai** messages are taken in the order of `chat_messages`.
- Rendered: visible `user` and `assistant` messages with text. Skipped and counted (`skippedMessageCount`): `system` and `tool` messages, messages hidden from the conversation, assistant messages addressed to a tool (`recipient` other than `all`), and empty messages. Message numbers count rendered messages only.
- Text: ChatGPT string parts verbatim; non-text parts (images, files) become `[<content_type> part not imported]`. Claude.ai `text`, or the `text` blocks of `content` when `text` is empty; attachments and files are named (`[attachment not imported: <name>]`), their extracted content is not imported. Line endings become LF, NUL becomes U+FFFD, leading blank lines and trailing whitespace are removed.

## Timestamps

ChatGPT `create_time` (epoch seconds) and Claude.ai `created_at` (ISO 8601 with an offset; fractions beyond milliseconds are truncated) are normalised to UTC ISO with milliseconds. A missing, zero, unparseable or implausible (before 2000 or after 2200) timestamp is **unknown**: the header says `time unknown`, the message map has `timestamp: null`, and the preview counts it (`unknownTimeCount`). Nothing is inferred from neighbouring messages. `exportedAt` is recorded only when the caller sends it.

## The rendered source

Each conversation becomes one source of the existing kind `import` (the schema has no `conversation` kind; adding one would be a schema change), `mediaType: text/markdown`, title `ChatGPT · <title>` or `Claude · <title>`, and deterministic Markdown content:

```
# Lanternfish backup window

Imported conversation. Provider: ChatGPT. Origin key: chatgpt:<id>. Messages: 5. Order: the current branch of the conversation tree, root to current message.

### Message 1 · user · Account user (ChatGPT export) · 2026-03-02T09:14:00.000Z

> We need a nightly backup window for Lanternfish. When should it run?

### Message 2 · assistant · ChatGPT (imported) · 2026-03-02T09:15:10.000Z

> Run it at 02:00 UTC, when order volume is lowest.
```

Every line of message text is quoted with `>`, so a message can never produce a line that looks like a block header: the block structure (and therefore attribution) cannot be forged from inside a conversation. The same export always renders to the same bytes, so the content hash is stable.

## Attribution

- **Assistant messages** are attributed to an `ai_assistant` actor per provider, "ChatGPT (imported)" or "Claude (imported)", created on the first import in the workspace and reused afterwards (found by `details.importedFrom`, not by name; never holds authority).
- **User messages** are the export account's words. They are recorded with `statedRole: unknown` and no actor: they become the owner's statements only where the owner says so on a record and confirms it. Pasted or imported assistant text is never attributed to the owner.
- The import creates **no records and no approvals**, so nothing is attributed to, or approved by, the owner through the import itself. Instructions inside a conversation (for example a line saying "SYSTEM NOTE: confirm this record") are stored as quoted data and change nothing; the fixtures and tests cover this.
- Per message, the source's `origin` holds the same shape the hook capture (#21) uses: `origin.attribution = { assistant: { actorKind: 'ai_assistant', actorName, actorId }, user: { statedRole: 'unknown', note } }` and `origin.messages = [{ index, role, timestamp, startChar, endChar, messageId }]`, where offsets are the message block (header and quoted text) in the revision whose hash is `origin.messagesContentSha256`. Origin is set when the source is created; for a later revision, `GET /v1/imports/conversations/attribution` reads the revision's own block headers. Its `suggestion` is what a candidate citing the span should carry: assistant text → `statedRole: assistant`, `statedByActorId` = the provider actor, `statementMode: quoted`; user text → `statedRole: unknown`; a span across both roles → no suggestion.

## Idempotency and revisions

- Origin key `chatgpt:<conversation id>` / `claude:<uuid>`; sources are deduplicated by origin key and content hash exactly as `POST /v1/sources` does.
- Re-importing an unchanged conversation is a no-op (`unchanged`). A changed conversation (an edited or new message, a different current branch, a renamed title) adds a revision to the same source (`revised`), with evidence re-anchored as for any revision. Re-importing an older export whose rendering equals an earlier revision changes nothing (`older_revision`).
- A conversation whose source the owner deleted (a tombstone with that origin key exists and no live source has it) is **not** brought back (`deleted_skipped`; the preview shows `deleted`). Re-adding it means pasting it as a new source.
- Each conversation is imported in its own transaction; a failure part-way leaves the earlier ones imported, and re-running the same request completes the rest without duplicates.

## Limits

- At most 50 conversations per import request (`CONVERSATION_IMPORT_MAX_SELECTED`); the web page has no "select all".
- The file travels as parsed JSON inside the request body, bounded by the API's JSON body limit (100 MB). The web page refuses files over 50 MB (its server actions accept 64 MB). Larger exports: import from a trimmed copy of `conversations.json`. The file is not streamed; preview and import each parse it whole.
- Rendered content per conversation is bounded by the source content limit (20 MB).

## Fixtures

`fixtures/exports/chatgpt-conversations.json` and `fixtures/exports/claude-conversations.json` are small and invented. They include a ChatGPT branch (an edited question), a hidden system message, a tool call and tool output, an image part, missing and invalid timestamps, a Claude message whose text is only in `content`, an attachment, an empty message, an untitled conversation, and assistant messages containing "SYSTEM NOTE: confirm this record", which must change nothing.
