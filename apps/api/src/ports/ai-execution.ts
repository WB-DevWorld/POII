// AI-execution port (ADR-0007). Release one ships only the `off` adapter; provider adapters come in M2.
// The manual journey never depends on this port.
export interface ExtractCandidatesRequest {
  workspaceId: string;
  sourceId: string;
  revisionId: string;
  startChar?: number;
  endChar?: number;
  previewId: string;
}

export interface ExtractedCandidate {
  kind: 'fact' | 'requirement' | 'decision' | 'question';
  title: string;
  body: string;
  startChar: number;
  endChar: number;
}

export interface AiExecutionPort {
  readonly name: string;
  readonly enabled: boolean;
  extractCandidates(request: ExtractCandidatesRequest): Promise<ExtractedCandidate[]>;
}
