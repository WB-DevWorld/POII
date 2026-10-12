'use server';

// #20 conversation import server actions. The browser hands over the export file; these forward its parsed
// JSON to the API, which validates the shape, and returns either the preview or the per-conversation outcomes.
import type { ConversationImportResponse, ConversationPreviewResponse } from '@poii/contracts';
import { apiJson, toProblem, type Problem } from '@/lib/api';
import { checkExportFile, MAX_SELECTED, parseExportText } from './logic';

export type PreviewState = { ok: true; preview: ConversationPreviewResponse } | { ok: false; problem: Problem };
export type ImportState = { ok: true; result: ConversationImportResponse } | { ok: false; problem: Problem };

const invalid = (message: string) => ({ ok: false as const, problem: { code: 'invalid_input', message } });

async function readExport(fd: FormData): Promise<{ ok: true; data: unknown; fileName: string } | { ok: false; message: string }> {
  const file = fd.get('file');
  if (!(file instanceof File)) return { ok: false, message: 'Choose the conversations.json file from your export.' };
  const problem = checkExportFile(file);
  if (problem) return { ok: false, message: problem };
  const parsed = parseExportText(await file.text());
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.data, fileName: file.name.slice(0, 500) };
}

/** Lists the conversations in the file. Nothing is stored. */
export async function previewConversationsAction(fd: FormData): Promise<PreviewState> {
  const file = await readExport(fd);
  if (!file.ok) return invalid(file.message);
  try {
    const preview = await apiJson<ConversationPreviewResponse>('/v1/imports/conversations/preview', {
      method: 'POST', body: { file: file.data, fileName: file.fileName },
    });
    return { ok: true, preview };
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
}

/** Imports exactly the selected conversations. */
export async function importConversationsAction(fd: FormData): Promise<ImportState> {
  const file = await readExport(fd);
  if (!file.ok) return invalid(file.message);
  let conversationIds: unknown;
  try {
    conversationIds = JSON.parse(String(fd.get('conversationIds') ?? '[]'));
  } catch {
    conversationIds = null;
  }
  if (!Array.isArray(conversationIds) || !conversationIds.length || !conversationIds.every(id => typeof id === 'string')) {
    return invalid('Select at least one conversation.');
  }
  if (conversationIds.length > MAX_SELECTED) return invalid(`Select at most ${MAX_SELECTED} conversations per import.`);
  try {
    const result = await apiJson<ConversationImportResponse>('/v1/imports/conversations', {
      method: 'POST',
      body: { file: file.data, fileName: file.fileName, conversationIds, aiAllowed: fd.get('neverSendToAi') !== 'on' },
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
}
