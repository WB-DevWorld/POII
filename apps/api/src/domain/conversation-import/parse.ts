// #20 conversation import: recognise and validate an export file, then parse every conversation in it. Pure.
// Anything that is not one of the two supported shapes is refused as a whole; nothing is guessed.
import type { z } from 'zod';
import { ChatGptExport, looksLikeChatGpt, parseChatGptConversation } from './chatgpt.js';
import { ClaudeExport, looksLikeClaude, parseClaudeConversation } from './claude.js';
import { ExportShapeError } from './shared.js';
import { IMPORTED_FROM, type ParsedExport } from './types.js';

function issuesOf(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 10).map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

/**
 * Recognises the official ChatGPT or Claude.ai `conversations.json` (already JSON-parsed) and parses it.
 * Throws ExportShapeError for anything else: not an array, empty, mixed or unknown shapes, duplicate ids.
 */
export function parseConversationExport(file: unknown): ParsedExport {
  if (!Array.isArray(file)) {
    throw new ExportShapeError('Expected the conversations.json of a ChatGPT or Claude.ai export: a JSON array of conversations');
  }
  if (file.length === 0) throw new ExportShapeError('The file contains no conversations');
  const first: unknown = file[0];
  let parsed: ParsedExport;
  if (looksLikeChatGpt(first)) {
    const result = ChatGptExport.safeParse(file);
    if (!result.success) throw new ExportShapeError('The file looks like a ChatGPT export but does not match its shape', issuesOf(result.error));
    parsed = { provider: 'chatgpt', importedFrom: IMPORTED_FROM.chatgpt, conversations: result.data.map((c, i) => parseChatGptConversation(c, i)) };
  } else if (looksLikeClaude(first)) {
    const result = ClaudeExport.safeParse(file);
    if (!result.success) throw new ExportShapeError('The file looks like a Claude.ai export but does not match its shape', issuesOf(result.error));
    parsed = { provider: 'claude', importedFrom: IMPORTED_FROM.claude, conversations: result.data.map(c => parseClaudeConversation(c)) };
  } else {
    throw new ExportShapeError('Unrecognised export: neither a ChatGPT export (conversations with "mapping") nor a Claude.ai export (conversations with "chat_messages")');
  }
  const seen = new Set<string>();
  for (const conversation of parsed.conversations) {
    if (seen.has(conversation.id)) throw new ExportShapeError(`Conversation id ${conversation.id} appears more than once in the file`);
    seen.add(conversation.id);
  }
  return parsed;
}

/** First and last known message times, and how many messages have none. */
export function messageTimes(messages: ReadonlyArray<{ createdAt: string | null }>) {
  const known = messages.map(m => m.createdAt).filter((t): t is string => t !== null).sort();
  return { first: known[0] ?? null, last: known[known.length - 1] ?? null, unknownCount: messages.length - known.length };
}
