// #19 Export the current decisions as AGENTS.md / CLAUDE.md for a coding agent in another repository.
import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiRaw, apiTry } from '@/lib/api';
import { agentFileApiPath, agentFileHref, byteLabel, isAgentInstructionsRun } from '@/lib/agent-instructions';
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';
import { createAgentInstructionsAction } from './actions';

export const metadata: Metadata = { title: 'Export agent instructions' };

/** The generated AGENTS.md text, or null when it cannot be read. */
async function agentsText(exportRunId: string): Promise<string | null> {
  try {
    const reply = await apiRaw(agentFileApiPath(exportRunId, 'AGENTS.md'), { headers: { accept: 'text/markdown' } });
    return reply.ok ? await reply.text() : null;
  } catch {
    return null;
  }
}

export default async function AgentInstructionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const runId = first(sp.run);
  const run = runId ? await apiTry<unknown>(`/v1/exports/${encodeURIComponent(runId)}`) : null;
  const doc = run?.ok && isAgentInstructionsRun(run.data) ? run.data : null;
  const text = doc ? await agentsText(doc.exportRunId) : null;

  return (
    <section>
      <p className="muted">
        <a href="/export">← Export</a>
      </p>
      <h1>Export agent instructions</h1>
      <p className="lede">
        Writes the current decisions and requirements as <span className="mono">AGENTS.md</span> and{' '}
        <span className="mono">CLAUDE.md</span> for a coding agent in another repository. Each one quotes its evidence and cites the
        record, source, revision, exact span and approval. Superseded decisions are left out. Anything that cites a source marked
        never send to AI appears only as its title.
      </p>

      <ActionForm action={createAgentInstructionsAction} className="card stack" aria-label="Agent instructions" testId="agent-instructions-form">
        <p className="hint">
          The files are generated, not edited: change a decision in POII and export again. The same decisions always give the same
          content hash.
        </p>
        <div className="row actions">
          <SubmitButton>Export agent instructions</SubmitButton>
        </div>
      </ActionForm>

      {run && !run.ok ? <ProblemNotice problem={run.problem} title="That export could not be loaded." /> : null}
      {run?.ok && !doc ? <p className="notice">That export is not an agent instructions export.</p> : null}
      {doc ? (
        <div className="card" data-testid="agent-instructions">
          <h2>Generated {formatTime(doc.generatedAt)}</h2>
          <p>
            {doc.included.length} included · {doc.withheld.length} withheld · format {doc.format} v{doc.formatVersion}
          </p>
          <p>
            Content sha256 <span className="mono" data-testid="agent-instructions-hash">{doc.contentSha256}</span>
          </p>
          <p className="row">
            {doc.files.map((f, i) => (
              <a
                key={f.name}
                className={i === 0 ? 'button' : 'button secondary'}
                href={agentFileHref(doc.exportRunId, f.name)}
                download={f.name}
                data-testid={`download-${f.name}`}
              >
                Download {f.name} ({byteLabel(f.bytes)})
              </a>
            ))}
          </p>
          <h3>Withheld ({doc.withheld.length})</h3>
          {doc.withheld.length === 0 ? (
            <p className="hint">Nothing was withheld.</p>
          ) : (
            <div className="table-wrap">
              <table data-testid="agent-instructions-withheld">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.withheld.map(w => (
                    <tr key={w.recordId}>
                      <td>
                        <a href={`/records/${w.recordId}`}>{w.title}</a>
                      </td>
                      <td>{w.kind}</td>
                      <td>never send to AI: content withheld</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>AGENTS.md</h3>
          {text === null ? (
            <p className="notice">The generated file could not be loaded.</p>
          ) : (
            <pre className="snapshot" data-testid="agent-instructions-text">{text}</pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
