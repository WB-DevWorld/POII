// `off` AI-execution adapter: the default. Every call fails with ai_disabled; the manual path is unaffected.
import { AppError } from '../common/errors.js';
import type { AiExecution, AiExecutionPort, AiPreview, AiStatusInfo, AiUsageInfo } from '../ports/ai-execution.js';

export const aiDisabled = () => new AppError(503, 'ai_disabled', 'AI execution is off; use the manual path');

export class OffAiExecution implements AiExecutionPort {
  readonly name = 'off';
  readonly enabled = false;

  status(): AiStatusInfo {
    throw aiDisabled();
  }

  async usage(): Promise<AiUsageInfo> {
    throw aiDisabled();
  }

  async preview(): Promise<AiPreview> {
    throw aiDisabled();
  }

  async execute(): Promise<AiExecution> {
    throw aiDisabled();
  }
}
