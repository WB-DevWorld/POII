// #20 conversation import: the official Claude.ai data export (`conversations.json`). Pure.
// Shape as observed in 2026 exports: an array of conversations ({ uuid, name, created_at, updated_at,
// chat_messages }), each message { uuid, sender: human | assistant, created_at, text, content[], attachments[], files[] }.
import { z } from 'zod';
import { CONVERSATION_ID, cleanText, cleanTitle } from './shared.js';
import { normaliseIso } from './timestamps.js';
import type { ParsedConversation, ParsedMessage } from './types.js';

const ClaudeContentBlock = z.looseObject({ type: z.string(), text: z.string().nullish() });
const ClaudeFile = z.looseObject({ file_name: z.string().nullish() });

const ClaudeMessage = z.looseObject({
  uuid: z.string().optional(),
  sender: z.enum(['human', 'assistant']),
  text: z.string().nullish(),
  content: z.array(ClaudeContentBlock).nullish(),
  created_at: z.string().nullish(),
  attachments: z.array(ClaudeFile).nullish(),
  files: z.array(ClaudeFile).nullish(),
});

export const ClaudeConversation = z.looseObject({
  uuid: z.string().regex(CONVERSATION_ID),
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  chat_messages: z.array(ClaudeMessage),
});

export const ClaudeExport = z.array(ClaudeConversation);

type Conversation = z.infer<typeof ClaudeConversation>;
type Message = z.infer<typeof ClaudeMessage>;

/** `text`, or the text blocks of `content` when `text` is empty; attachments are named, never inlined. */
function messageText(message: Message): string {
  let text = typeof message.text === 'string' ? message.text : '';
  if (!text.trim() && message.content?.length) {
    text = message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text!).join('\n\n');
  }
  const notes = [...(message.attachments ?? []), ...(message.files ?? [])]
    .map(file => (typeof file.file_name === 'string' ? file.file_name.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
    .map(name => `[attachment not imported: ${name}]`);
  return [text, ...notes].filter(part => part.trim()).join('\n\n');
}

export function parseClaudeConversation(conversation: Conversation): ParsedConversation {
  const messages: ParsedMessage[] = [];
  let skipped = 0;
  for (const message of conversation.chat_messages) {
    const text = cleanText(messageText(message));
    if (!text) {
      skipped++;
      continue;
    }
    messages.push({
      index: messages.length + 1,
      messageId: message.uuid ?? null,
      role: message.sender === 'human' ? 'user' : 'assistant',
      createdAt: normaliseIso(message.created_at),
      text,
    });
  }
  return {
    provider: 'claude',
    id: conversation.uuid,
    originKey: `claude:${conversation.uuid}`,
    title: cleanTitle(conversation.name),
    createdAt: normaliseIso(conversation.created_at),
    updatedAt: normaliseIso(conversation.updated_at),
    linearisation: 'array_order',
    messages,
    skippedMessageCount: skipped,
    otherBranchMessageCount: 0,
  };
}

export const looksLikeClaude = (item: unknown): boolean =>
  !!item && typeof item === 'object' && 'chat_messages' in item && !('mapping' in item);
