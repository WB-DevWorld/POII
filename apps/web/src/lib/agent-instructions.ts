// #19 Pure helpers for the agent instructions export pages (no React, no fetch), unit-tested in test/agent-instructions.test.ts.
// Type-only import: the web unit tests run under tsx/CommonJS, where @poii/contracts (ESM only) cannot be loaded, so
// the two values below repeat AGENT_INSTRUCTIONS_FORMAT and agentInstructionFileNames (the test checks the source).
import type { AgentInstructionFileName, AgentInstructionsResponse } from '@poii/contracts';

export const AGENT_INSTRUCTIONS_FORMAT = 'poii.agent-instructions';
export const AGENT_FILE_NAMES: readonly AgentInstructionFileName[] = ['AGENTS.md', 'CLAUDE.md'];

/** True for an export run manifest (GET /v1/exports) written by the agent instructions export. */
export function isAgentInstructionsManifest(manifest: Record<string, unknown> | null | undefined): boolean {
  return !!manifest && manifest.format === AGENT_INSTRUCTIONS_FORMAT;
}

/** True for the stored run document (GET /v1/exports/:id) of an agent instructions export. */
export function isAgentInstructionsRun(value: unknown): value is AgentInstructionsResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.format === AGENT_INSTRUCTIONS_FORMAT && typeof v.exportRunId === 'string' && Array.isArray(v.files)
    && Array.isArray(v.withheld) && Array.isArray(v.included) && typeof v.contentSha256 === 'string';
}

export function isAgentFileName(name: string): name is AgentInstructionFileName {
  return (AGENT_FILE_NAMES as readonly string[]).includes(name);
}

/** The web app's download route for one generated file. */
export function agentFileHref(exportRunId: string, name: AgentInstructionFileName): string {
  return `/export/${encodeURIComponent(exportRunId)}/files/${name}`;
}

/** The API path the download route proxies. */
export function agentFileApiPath(exportRunId: string, name: AgentInstructionFileName): string {
  return `/v1/exports/${encodeURIComponent(exportRunId)}/files/${name}`;
}

/** Label for the "Kind" column of the export list: the manifest format tells agent instructions apart. */
export function exportKindLabel(run: { kind: string; formatVersion: number; manifest: Record<string, unknown> }): string {
  if (isAgentInstructionsManifest(run.manifest)) return `agent instructions v${run.formatVersion}`;
  return `${run.kind === 'context_pack' ? 'context pack' : run.kind === 'backup' ? 'backup' : run.kind} v${run.formatVersion}`;
}

/** "1,234 bytes" style size, stable across locales. */
export function byteLabel(bytes: number): string {
  return `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} bytes`;
}
