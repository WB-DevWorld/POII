'use server';

// #13 AI server actions. Every call goes to the API over HTTP; the API enforces never-send, caps and
// single-use previews whatever this page offers.
import { redirect } from 'next/navigation';
import type { AiExecuteResponse, AiPreviewResponse } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { apiJson, toProblem, type Problem } from '@/lib/api';
import { aiPageHref, parsePreviewForm } from './logic';

export type AiSendState = { ok: true; result: AiExecuteResponse } | { ok: false; problem: Problem } | null;

/** Creates a preview (nothing is sent) and shows it. */
export async function previewAiAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = parsePreviewForm(fd);
  if (!parsed.ok) return { ok: false, problem: { code: 'invalid_input', message: parsed.message } };
  let preview: AiPreviewResponse;
  try {
    preview = await apiJson<AiPreviewResponse>('/v1/ai/preview', { method: 'POST', body: parsed.body });
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
  redirect(aiPageHref(parsed.body.sourceId, { preview: preview.previewId }));
}

/** Sends exactly the previewed text. Returns the new candidates (or the reason nothing was sent). */
export async function executeAiAction(_state: AiSendState, fd: FormData): Promise<AiSendState> {
  const previewId = fd.get('previewId');
  if (typeof previewId !== 'string' || !previewId) return { ok: false, problem: { code: 'invalid_input', message: 'The preview is missing.' } };
  try {
    const result = await apiJson<AiExecuteResponse>('/v1/ai/execute', { method: 'POST', body: { previewId } });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
}
