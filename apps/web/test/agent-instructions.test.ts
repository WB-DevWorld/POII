// #19 Unit tests of the agent instructions page helpers. Pure functions; nothing is mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentFileApiPath, agentFileHref, AGENT_FILE_NAMES, AGENT_INSTRUCTIONS_FORMAT, byteLabel, exportKindLabel, isAgentFileName, isAgentInstructionsManifest,
  isAgentInstructionsRun,
} from '../src/lib/agent-instructions';

const runId = '01900000-0000-7000-8000-000000000001';

test('agent instructions: runs are told apart by the manifest format, not the stored kind', () => {
  assert.equal(isAgentInstructionsManifest({ format: 'poii.agent-instructions' }), true);
  assert.equal(isAgentInstructionsManifest({ format: 'poii.context-pack' }), false);
  assert.equal(isAgentInstructionsManifest({}), false);
  assert.equal(isAgentInstructionsManifest(null), false);
  assert.equal(exportKindLabel({ kind: 'context_pack', formatVersion: 1, manifest: { format: 'poii.agent-instructions' } }), 'agent instructions v1');
  assert.equal(exportKindLabel({ kind: 'context_pack', formatVersion: 1, manifest: { format: 'poii.context-pack' } }), 'context pack v1');
  assert.equal(exportKindLabel({ kind: 'backup', formatVersion: 1, manifest: {} }), 'backup v1');
});

test('agent instructions: run document guard', () => {
  const doc = { format: 'poii.agent-instructions', exportRunId: runId, files: [], included: [], withheld: [], contentSha256: 'a'.repeat(64) };
  assert.equal(isAgentInstructionsRun(doc), true);
  assert.equal(isAgentInstructionsRun({ ...doc, format: 'poii.context-pack' }), false);
  assert.equal(isAgentInstructionsRun({ manifest: {}, markdown: '' }), false);
  assert.equal(isAgentInstructionsRun(null), false);
});

test('agent instructions: only the two file names, and links that stay inside the app and the API', () => {
  assert.deepEqual([...AGENT_FILE_NAMES], ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(isAgentFileName('AGENTS.md'), true);
  assert.equal(isAgentFileName('../secrets'), false);
  assert.equal(isAgentFileName('agents.md'), false);
  assert.equal(agentFileHref(runId, 'AGENTS.md'), `/export/${runId}/files/AGENTS.md`);
  assert.equal(agentFileApiPath('a/b', 'CLAUDE.md'), '/v1/exports/a%2Fb/files/CLAUDE.md');
  assert.equal(byteLabel(1234567), '1,234,567 bytes');
  assert.equal(byteLabel(12), '12 bytes');
});

test('agent instructions: the local constants match @poii/contracts', () => {
  const contracts = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'contracts', 'src', 'api.ts'), 'utf8');
  assert.ok(contracts.includes(`export const AGENT_INSTRUCTIONS_FORMAT = '${AGENT_INSTRUCTIONS_FORMAT}';`));
  assert.ok(contracts.includes(`export const agentInstructionFileNames = [${AGENT_FILE_NAMES.map(n => `'${n}'`).join(', ')}] as const;`));
});
