// #20 conversation import: deterministic Markdown rendering of one conversation, and reading the message
// blocks back from stored text so any span can be attributed. Pure.
//
// Layout (docs/conversation-import.md):
//   # <title>
//
//   Imported conversation. Provider: ChatGPT. Origin key: chatgpt:<id>. Messages: <n>. Order: ...
//
//   ### Message 1 · user · Account user (ChatGPT export) · 2026-03-01T10:00:00.000Z
//
//   > message text, every line quoted
//
// Every line of message text starts with ">", so a message can never forge a block header.
import type { ImportedMessageAttribution } from '@poii/contracts';
import { ASSISTANT_ACTOR_NAME, PROVIDER_LABEL, USER_LABEL, type MessageRole, type ParsedConversation } from './types.js';

export const TIME_UNKNOWN = 'time unknown';
const HEADER = /^### Message (\d+) · (user|assistant) · (.+) · (time unknown|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export interface MessageBlock {
  index: number;
  role: MessageRole;
  createdAt: string | null;
  /** From the start of the header line to the end of the last quoted line. */
  startChar: number;
  endChar: number;
}

export interface RenderedConversation {
  content: string;
  blocks: MessageBlock[];
}

const ORDER: Record<ParsedConversation['linearisation'], string> = {
  current_node: 'Order: the current branch of the conversation tree, root to current message.',
  latest_leaf: 'Order: the latest branch of the conversation tree (the export names no current message).',
  array_order: 'Order: as listed in the export.',
};

const quote = (text: string) => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

export function renderConversation(conversation: ParsedConversation): RenderedConversation {
  const { provider } = conversation;
  let out = `# ${conversation.title}\n\n`;
  out += `Imported conversation. Provider: ${PROVIDER_LABEL[provider]}. Origin key: ${conversation.originKey}. `
    + `Messages: ${conversation.messages.length}. ${ORDER[conversation.linearisation]}\n`;
  const blocks: MessageBlock[] = [];
  for (const message of conversation.messages) {
    out += '\n';
    const startChar = out.length;
    const speaker = message.role === 'assistant' ? ASSISTANT_ACTOR_NAME[provider] : USER_LABEL[provider];
    out += `### Message ${message.index} · ${message.role} · ${speaker} · ${message.createdAt ?? TIME_UNKNOWN}\n\n`;
    out += quote(message.text);
    blocks.push({ index: message.index, role: message.role, createdAt: message.createdAt, startChar, endChar: out.length });
    out += '\n';
  }
  return { content: out, blocks };
}

/** Message blocks of a stored rendering, read from its header lines (any revision of an imported source). */
export function readMessageBlocks(content: string): MessageBlock[] {
  const headers: Array<{ index: number; role: MessageRole; createdAt: string | null; startChar: number }> = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const match = HEADER.exec(line);
    if (match) {
      headers.push({
        index: Number(match[1]), role: match[2] as MessageRole, createdAt: match[4] === TIME_UNKNOWN ? null : match[4]!, startChar: offset,
      });
    }
    offset += line.length + 1;
  }
  return headers.map((header, i) => {
    let endChar = i + 1 < headers.length ? headers[i + 1]!.startChar : content.length;
    while (endChar > header.startChar && content[endChar - 1] === '\n') endChar--;
    return { ...header, endChar };
  });
}

/**
 * Per-message attribution: assistant messages are the provider's ai_assistant actor; the export's user is
 * `unknown` (never the owner) until the owner states otherwise on a record.
 */
export function attributeBlocks(
  blocks: MessageBlock[],
  assistantActorId: string,
  messageIds: ReadonlyMap<number, string | null> = new Map(),
): ImportedMessageAttribution[] {
  return blocks.map(block => ({
    index: block.index,
    messageId: messageIds.get(block.index) ?? null,
    exportRole: block.role,
    statedRole: block.role === 'assistant' ? 'assistant' : 'unknown',
    statedByActorId: block.role === 'assistant' ? assistantActorId : null,
    statementMode: 'quoted',
    createdAt: block.createdAt,
    timeStatus: block.createdAt ? 'known' : 'unknown',
    startChar: block.startChar,
    endChar: block.endChar,
  }));
}

export type SpanAttribution = {
  messages: ImportedMessageAttribution[];
  suggestion: { statedRole: 'assistant' | 'unknown'; statedByActorId: string | null; statementMode: 'quoted' } | null;
  reason: 'single_role' | 'mixed_roles' | 'outside_messages';
};

/** Which messages a span [startChar, endChar) of a stored rendering touches, and the attribution a candidate should carry. */
export function attributeSpan(
  content: string,
  startChar: number,
  endChar: number,
  assistantActorId: string,
  messageIds?: ReadonlyMap<number, string | null>,
): SpanAttribution {
  const touched = readMessageBlocks(content).filter(block => block.startChar < endChar && block.endChar > startChar);
  const messages = attributeBlocks(touched, assistantActorId, messageIds);
  if (!messages.length) return { messages, suggestion: null, reason: 'outside_messages' };
  const roles = new Set(messages.map(m => m.exportRole));
  if (roles.size > 1) return { messages, suggestion: null, reason: 'mixed_roles' };
  const { statedRole, statedByActorId, statementMode } = messages[0]!;
  return { messages, suggestion: { statedRole, statedByActorId, statementMode }, reason: 'single_role' };
}
