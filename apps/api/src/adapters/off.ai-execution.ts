// `off` AI-execution adapter: the default. Every call fails with ai_disabled; the manual path is unaffected.
import { AppError } from '../common/errors.js';
import type { AiExecutionPort, ExtractCandidatesRequest, ExtractedCandidate } from '../ports/ai-execution.js';

export class OffAiExecution implements AiExecutionPort {
  readonly name = 'off';
  readonly enabled = false;

  async extractCandidates(_request: ExtractCandidatesRequest): Promise<ExtractedCandidate[]> {
    throw new AppError(503, 'ai_disabled', 'AI execution is off; use the manual path');
  }
}
