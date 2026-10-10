// #20 conversation import: the official ChatGPT data export (`conversations.json`). Pure.
// Shape as observed in 2026 exports: an array of conversations, each with a `mapping` tree of nodes
// ({ id, message, parent, children }) and `current_node`, the leaf of the branch the app shows.
import { z } from 'zod';
import { CONVERSATION_ID, cleanText, cleanTitle, ExportShapeError } from './shared.js';
import { epochSecondsToIso } from './timestamps.js';
import type { ParsedConversation, ParsedMessage } from './types.js';

const ChatGptMessage = z.looseObject({
  id: z.string().optional(),
  author: z.looseObject({ role: z.string(), name: z.string().nullish() }),
  create_time: z.number().nullish(),
  content: z.looseObject({
    content_type: z.string(),
    parts: z.array(z.unknown()).nullish(),
    text: z.string().nullish(),
  }),
  recipient: z.string().nullish(),
  metadata: z.looseObject({ is_visually_hidden_from_conversation: z.boolean().nullish() }).nullish(),
});

const ChatGptNode = z.looseObject({
  id: z.string().optional(),
  message: ChatGptMessage.nullish(),
  parent: z.string().nullish(),
  children: z.array(z.string()).nullish(),
});

export const ChatGptConversation = z.looseObject({
  title: z.string().nullish(),
  create_time: z.number().nullish(),
  update_time: z.number().nullish(),
  mapping: z.record(z.string(), ChatGptNode),
  current_node: z.string().nullish(),
  conversation_id: z.string().regex(CONVERSATION_ID).optional(),
  id: z.string().regex(CONVERSATION_ID).optional(),
}).refine(c => !!(c.conversation_id ?? c.id), { message: 'A ChatGPT conversation needs conversation_id or id', path: ['conversation_id'] });

export const ChatGptExport = z.array(ChatGptConversation);

type Conversation = z.infer<typeof ChatGptConversation>;
type Message = z.infer<typeof ChatGptMessage>;

/** Readable text of a message: string parts as they are, other parts as an explicit placeholder. */
function messageText(message: Message): string {
  const { content } = message;
  if (Array.isArray(content.parts) && content.parts.length) {
    return content.parts.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const { text, content_type: type } = part as { text?: unknown; content_type?: unknown };
        if (typeof text === 'string') return text;
        return `[${typeof type === 'string' ? type.replace(/[^\w.-]/g, '') || 'non-text' : 'non-text'} part not imported]`;
      }
      return '[non-text part not imported]';
    }).join('\n');
  }
  return typeof content.text === 'string' ? content.text : '';
}

/** Only visible user and assistant turns addressed to the conversation are rendered. */
function renderable(message: Message): { role: 'user' | 'assistant'; text: string } | null {
  const role = message.author.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (message.metadata?.is_visually_hidden_from_conversation) return null;
  // Assistant messages addressed to a tool (code interpreter, browsing) are tool calls, not turns.
  if (role === 'assistant' && message.recipient && message.recipient !== 'all') return null;
  const text = cleanText(messageText(message));
  return text ? { role, text } : null;
}

/**
 * The current branch, root first: from `current_node` up the `parent` links. Without a usable `current_node`,
 * the latest leaf: from the single root, always the last child.
 */
function currentPath(conversation: Conversation, where: string): { ids: string[]; linearisation: 'current_node' | 'latest_leaf' } {
  const mapping = conversation.mapping;
  let leaf = conversation.current_node && mapping[conversation.current_node] ? conversation.current_node : null;
  let linearisation: 'current_node' | 'latest_leaf' = 'current_node';
  if (!leaf) {
    linearisation = 'latest_leaf';
    const roots = Object.keys(mapping).filter(id => {
      const parent = mapping[id]!.parent;
      return !parent || !mapping[parent];
    });
    if (roots.length !== 1) throw new ExportShapeError(`${where}: the message tree has ${roots.length} roots and no current_node`);
    let current: string = roots[0]!;
    const walked = new Set<string>([current]);
    for (;;) {
      const children: string[] = (mapping[current]!.children ?? []).filter(child => !!mapping[child]);
      const next: string | undefined = children[children.length - 1];
      if (!next) break;
      if (walked.has(next)) throw new ExportShapeError(`${where}: the message tree has a cycle`);
      walked.add(next);
      current = next;
    }
    leaf = current;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = leaf; id && mapping[id]; id = mapping[id]!.parent) {
    if (seen.has(id)) throw new ExportShapeError(`${where}: the message tree has a cycle`);
    seen.add(id);
    ids.push(id);
  }
  return { ids: ids.reverse(), linearisation };
}

export function parseChatGptConversation(conversation: Conversation, position: number): ParsedConversation {
  const id = (conversation.conversation_id ?? conversation.id)!;
  const { ids, linearisation } = currentPath(conversation, `conversation ${position} (${id})`);
  const onPath = new Set(ids);
  const messages: ParsedMessage[] = [];
  let skipped = 0;
  for (const nodeId of ids) {
    const message = conversation.mapping[nodeId]!.message;
    if (!message) continue;
    const turn = renderable(message);
    if (!turn) {
      skipped++;
      continue;
    }
    messages.push({
      index: messages.length + 1,
      messageId: message.id ?? nodeId,
      role: turn.role,
      createdAt: epochSecondsToIso(message.create_time),
      text: turn.text,
    });
  }
  let otherBranch = 0;
  for (const [nodeId, node] of Object.entries(conversation.mapping)) {
    if (!onPath.has(nodeId) && node.message && renderable(node.message)) otherBranch++;
  }
  return {
    provider: 'chatgpt',
    id,
    originKey: `chatgpt:${id}`,
    title: cleanTitle(conversation.title),
    createdAt: epochSecondsToIso(conversation.create_time),
    updatedAt: epochSecondsToIso(conversation.update_time),
    linearisation,
    messages,
    skippedMessageCount: skipped,
    otherBranchMessageCount: otherBranch,
  };
}

export const looksLikeChatGpt = (item: unknown): boolean =>
  !!item && typeof item === 'object' && 'mapping' in item && !('chat_messages' in item);
