// #19 Agent instructions export: the current-decisions view as AGENTS.md and CLAUDE.md (docs/agent-instructions-export.md).
// Creating one needs the `read` capability, the same rule as context packs: an export is a rebuildable projection,
// and never-send content is withheld whoever asks. The run is stored as an export_run of kind `context_pack`
// (the export_kind enum has no other value without a migration) whose manifest carries
// `format: "poii.agent-instructions"`; that format, not the kind, identifies these runs.
import { Inject, Injectable } from '@nestjs/common';
import {
  AGENT_INSTRUCTIONS_FORMAT, AGENT_INSTRUCTIONS_VERSION, AgentInstructionFileName, type AgentInstructionsResponse,
} from '@poii/contracts';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { audit } from '../../common/audit.js';
import { notFound } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB, STORAGE_PORT } from '../../common/tokens.js';
import { newId } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { exportRun, source } from '../../db/schema/index.js';
import { AGENT_INSTRUCTION_KINDS, buildAgentInstructions, type AgentRecordInput } from '../../domain/agent-instructions-export.js';
import type { StoragePort } from '../../ports/storage.js';
import { loadApprovals, loadEvidence, toSummaries } from '../records/records.repository.js';
import { currentRecordRows } from '../views/views.service.js';

const fileKey = (exportRunId: string, name: AgentInstructionFileName) => `exports/${exportRunId}/${name}`;
const documentKey = (exportRunId: string) => `exports/${exportRunId}.json`;

@Injectable()
export class AgentInstructionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** The current decisions and requirements with their evidence and approvals, as the domain function takes them. */
  async currentRecords(workspaceId: string): Promise<{ records: AgentRecordInput[]; archivedSourceIds: Set<string> }> {
    const exec = this.db.orm;
    const rows = (await currentRecordRows(exec, workspaceId, null)).filter(r => AGENT_INSTRUCTION_KINDS.includes(r.kind));
    if (!rows.length) return { records: [], archivedSourceIds: new Set() };
    const ids = rows.map(r => r.id);
    const summaries = await toSummaries(exec, rows);
    const evidence = await loadEvidence(exec, ids);
    const approvals = await loadApprovals(exec, ids);
    const records: AgentRecordInput[] = [];
    rows.forEach((row, i) => {
      const list = approvals.get(row.id) ?? [];
      // As in the current-decisions view: a record is confirmed only through an approval; without one it is not current.
      if (!list.length) return;
      records.push({ summary: summaries[i]!, body: row.body, approvals: list, evidence: evidence.get(row.id) ?? [] });
    });
    const cited = [...new Set(records.flatMap(r => r.evidence.map(e => e.sourceId).filter((id): id is string => !!id)))];
    const archived = cited.length
      ? await exec.select({ id: source.id }).from(source)
        .where(and(eq(source.workspaceId, workspaceId), inArray(source.id, cited), isNotNull(source.archivedAt)))
      : [];
    return { records, archivedSourceIds: new Set(archived.map(a => a.id)) };
  }

  async create(ctx: RequestContext): Promise<AgentInstructionsResponse> {
    requireCapability(ctx.actor, 'read');
    const ws = ctx.workspace;
    const { records, archivedSourceIds } = await this.currentRecords(ws.id);
    const exportRunId = newId();
    const generatedAt = new Date().toISOString();
    const built = buildAgentInstructions({
      exportRunId, generatedAt, workspace: { id: ws.id, name: ws.name }, records, archivedSourceIds,
    });
    const response: AgentInstructionsResponse = {
      format: AGENT_INSTRUCTIONS_FORMAT,
      formatVersion: AGENT_INSTRUCTIONS_VERSION,
      exportRunId,
      generatedAt,
      workspace: { id: ws.id, name: ws.name },
      contentSha256: built.contentSha256,
      files: built.files.map(f => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
      included: built.included,
      withheld: built.withheld,
    };
    const keys = [...built.files.map(f => fileKey(exportRunId, f.name)), documentKey(exportRunId)];
    try {
      for (const f of built.files) await this.storage.put(fileKey(exportRunId, f.name), Buffer.from(f.text, 'utf8'));
      await this.storage.put(documentKey(exportRunId), Buffer.from(JSON.stringify(response), 'utf8'));
      await this.db.orm.transaction(async tx => {
        await tx.insert(exportRun).values({
          id: exportRunId, workspaceId: ws.id, kind: 'context_pack', formatVersion: AGENT_INSTRUCTIONS_VERSION,
          selection: { view: 'current-decisions', kinds: [...AGENT_INSTRUCTION_KINDS] },
          manifest: {
            format: AGENT_INSTRUCTIONS_FORMAT, formatVersion: AGENT_INSTRUCTIONS_VERSION, exportRunId, generatedAt,
            workspaceId: ws.id, contentSha256: built.contentSha256, files: response.files,
            recordCount: built.included.length + built.withheld.length, included: built.included, withheld: built.withheld,
          },
          contentSha256: built.contentSha256, storageKey: documentKey(exportRunId), createdByActorId: ctx.actor.id,
        });
        await audit(tx, ctx, 'export.agent_instructions', 'export_run', exportRunId, {
          contentSha256: built.contentSha256, included: built.included.length, withheld: built.withheld.length,
        });
      });
    } catch (error) {
      await Promise.all(keys.map(k => this.storage.delete(k).catch(() => undefined)));
      throw error;
    }
    return response;
  }

  /** One generated file of an agent-instructions run. 404 for other runs, other workspaces and unknown names. */
  async file(ctx: RequestContext, exportRunId: string, name: string): Promise<{ name: AgentInstructionFileName; text: string }> {
    requireCapability(ctx.actor, 'read');
    const parsed = AgentInstructionFileName.safeParse(name);
    if (!parsed.success) throw notFound('Export file');
    const run = (await this.db.orm.select().from(exportRun)
      .where(and(eq(exportRun.id, exportRunId), eq(exportRun.workspaceId, ctx.workspace.id))))[0];
    if (!run || run.manifest.format !== AGENT_INSTRUCTIONS_FORMAT) throw notFound('Export file');
    const bytes = await this.storage.get(fileKey(exportRunId, parsed.data));
    if (!bytes) throw notFound('Export file');
    return { name: parsed.data, text: Buffer.from(bytes).toString('utf8') };
  }
}
