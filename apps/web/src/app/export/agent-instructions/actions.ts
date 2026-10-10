'use server';

// #19 Server action: create an agent instructions export, then show it.
import { redirect } from 'next/navigation';
import type { AgentInstructionsResponse } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { apiJson, toProblem } from '@/lib/api';

export async function createAgentInstructionsAction(_state: ActionState, _fd: FormData): Promise<ActionState> {
  let run: AgentInstructionsResponse;
  try {
    run = await apiJson<AgentInstructionsResponse>('/v1/exports/agent-instructions', { method: 'POST', body: {} });
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
  redirect(`/export/agent-instructions?run=${encodeURIComponent(run.exportRunId)}`);
}
