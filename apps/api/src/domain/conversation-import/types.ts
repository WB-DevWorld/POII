// #20 conversation import: the provider-neutral shape both export parsers produce. Pure types.
import type { ConversationProvider } from '@poii/contracts';

export type ImportedFrom = 'chatgpt-export' | 'claude-export';

export const IMPORTED_FROM: Record<ConversationProvider, ImportedFrom> = { chatgpt: 'chatgpt-export', claude: 'claude-export' };
export const PROVIDER_LABEL: Record<ConversationProvider, string> = { chatgpt: 'ChatGPT', claude: 'Claude' };
/** Display name of the ai_assistant actor every imported assistant message is attributed to. */
export const ASSISTANT_ACTOR_NAME: Record<ConversationProvider, string> = { chatgpt: 'ChatGPT (imported)', claude: 'Claude (imported)' };
/** How the export's human side is named in the rendering: the account holder of the export, not "the owner". */
export const USER_LABEL: Record<ConversationProvider, string> = {
  chatgpt: 'Account user (ChatGPT export)', claude: 'Account user (Claude export)',
};

export type MessageRole = 'user' | 'assistant';

export interface ParsedMessage {
  /** 1-based position in the linearised conversation. */
  index: number;
  messageId: string | null;
  role: MessageRole;
  /** Normalised ISO 8601 (UTC, milliseconds), or null when the export has no usable timestamp. */
  createdAt: string | null;
  text: string;
}

export interface ParsedConversation {
  provider: ConversationProvider;
  id: string;
  originKey: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** How the message order was obtained. */
  linearisation: 'current_node' | 'latest_leaf' | 'array_order';
  messages: ParsedMessage[];
  skippedMessageCount: number;
  otherBranchMessageCount: number;
}

export interface ParsedExport {
  provider: ConversationProvider;
  importedFrom: ImportedFrom;
  conversations: ParsedConversation[];
}
