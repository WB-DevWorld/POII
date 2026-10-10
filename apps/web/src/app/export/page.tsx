import type { Metadata } from 'next';
import type { ContextPackResponse } from '@poii/contracts';
import { lifecycleStatuses, recordKinds, reviewStates } from '@poii/contracts';
import { createContextPackAction } from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry } from '@/lib/api';
import { agentFileHref, exportKindLabel, isAgentInstructionsManifest, isAgentInstructionsRun } from '@/lib/agent-instructions'; // #19
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';

export const metadata: Metadata = { title: 'Export' };

type ExportRun = { id: string; kind: 'context_pack' | 'backup'; formatVersion: number; createdAt: string; contentSha256: string; manifest: Record<string, unknown> };
type ManifestEntry = ContextPackResponse['manifest']['included'][number];

function ManifestTable({ title, entries, testId, empty }: { title: string; entries: ManifestEntry[]; testId: string; empty: string }) {
  return (
    <>
      <h3>
        {title} ({entries.length})
      </h3>
      {entries.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table data-testid={testId}>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Reason</th>
                <th scope="col">Revision</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={`${e.sourceId}-${e.revisionId ?? ''}`}>
                  <td>
                    {e.title && testId !== 'manifest-unavailable' ? <a href={`/sources/${e.sourceId}`}>{e.title}</a> : (e.title ?? <span className="mono">{e.sourceId}</span>)}
                  </td>
                  <td>{e.reason}</td>
                  <td className="mono">{e.revisionId ? `…${e.revisionId.slice(-8)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function isPack(value: unknown): value is ContextPackResponse {
  return !!value && typeof value === 'object' && 'manifest' in value && 'markdown' in value;
}

function count(manifest: Record<string, unknown>, key: string): number | null {
  const value = manifest[key];
  return Array.isArray(value) ? value.length : null;
}

export default async function ExportPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const runId = first(sp.run);
  const [run, runs] = await Promise.all([
    runId ? apiTry<unknown>(`/v1/exports/${encodeURIComponent(runId)}`) : Promise.resolve(null),
    apiTry<ExportRun[]>('/v1/exports'),
  ]);

  return (
    <section>
      <h1>Export a context pack</h1>
      <p className="lede">
        A cited pack in Markdown (for people and agents) and JSON (for programs), generated from one manifest that lists the
        sources it included, excluded and could not include.
      </p>

      {run && !run.ok ? <ProblemNotice problem={run.problem} title="That export could not be loaded." /> : null}
      {run?.ok && isPack(run.data) ? (
        <div className="card" data-testid="manifest">
          <h2>Pack generated {formatTime(run.data.manifest.generatedAt)}</h2>
          <p>
            For <strong>{run.data.manifest.destination === 'ai' ? 'an AI' : 'a person'}</strong> · {run.data.manifest.recordCount} records ·
            format {run.data.manifest.format} v{run.data.manifest.formatVersion}
          </p>
          <p className="row">
            <a className="button" href={`/export/${run.data.exportRunId}/markdown`} download data-testid="download-markdown">
              Download Markdown
            </a>
            <a className="button secondary" href={`/export/${run.data.exportRunId}/json`} download data-testid="download-json">
              Download JSON
            </a>
          </p>
          <ManifestTable title="Included" entries={run.data.manifest.included} testId="manifest-included" empty="No sources were included." />
          <ManifestTable title="Excluded" entries={run.data.manifest.excluded} testId="manifest-excluded" empty="Nothing was excluded." />
          <ManifestTable title="Unavailable" entries={run.data.manifest.unavailable} testId="manifest-unavailable" empty="Nothing was unavailable." />
          <details>
            <summary>Preview the Markdown</summary>
            <pre className="snapshot">{run.data.markdown}</pre>
          </details>
        </div>
      ) : null}
      {run?.ok && isAgentInstructionsRun(run.data) ? ( // #19
        <p className="notice">
          That export is an agent instructions export. <a href={`/export/agent-instructions?run=${run.data.exportRunId}`}>Show it</a>.
        </p>
      ) : run?.ok && !isPack(run.data) ? <p className="notice">That export is a backup. Download it from the list below.</p> : null}

      {/* #19 agent instructions export */}
      <div className="card" data-testid="agent-instructions-link">
        <h2>Agent instructions</h2>
        <p>
          The current decisions as <span className="mono">AGENTS.md</span> and <span className="mono">CLAUDE.md</span>, with citations, for a
          coding agent in another repository.
        </p>
        <p className="row">
          <a className="button" href="/export/agent-instructions">
            Export agent instructions
          </a>
        </p>
      </div>

      <h2>New pack</h2>
      <ActionForm action={createContextPackAction} className="card stack" aria-label="Context pack" testId="export-form">
        <fieldset>
          <legend>Destination</legend>
          <label className="check">
            <input type="radio" name="destination" value="person" defaultChecked /> A person
          </label>
          <label className="check">
            <input type="radio" name="destination" value="ai" /> An AI (leaves out everything marked never send to AI)
          </label>
        </fieldset>
        <fieldset>
          <legend>Kinds (none ticked = all)</legend>
          <div className="checks">
            {recordKinds.map(k => (
              <label key={k} className="check">
                <input type="checkbox" name="kinds" value={k} /> {k}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Review states</legend>
          <div className="checks">
            {reviewStates.map(s => (
              <label key={s} className="check">
                <input type="checkbox" name="reviewStates" value={s} defaultChecked={s === 'confirmed'} /> {s}
              </label>
            ))}
          </div>
          <p className="hint">Defaults to confirmed only.</p>
        </fieldset>
        <fieldset>
          <legend>Lifecycle statuses (none ticked = all)</legend>
          <div className="checks">
            {lifecycleStatuses.map(s => (
              <label key={s} className="check">
                <input type="checkbox" name="lifecycleStatuses" value={s} /> {s}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" name="includeExcerpts" defaultChecked /> Include excerpts
        </label>
        <label htmlFor="pack-title">Title (optional)</label>
        <input id="pack-title" name="title" maxLength={200} />
        <div className="row actions">
          <SubmitButton>Generate pack</SubmitButton>
        </div>
      </ActionForm>

      <h2>Previous exports</h2>
      {!runs.ok ? (
        <ProblemNotice problem={runs.problem} title="Previous exports could not be loaded." />
      ) : runs.data.length === 0 ? (
        <p className="muted">No exports yet.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="export-runs">
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Kind</th>
                <th scope="col">Sources</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map(r => {
                const agent = isAgentInstructionsManifest(r.manifest); // #19
                const included = count(r.manifest, 'included');
                const excluded = count(r.manifest, 'excluded');
                const unavailable = count(r.manifest, 'unavailable');
                return (
                  <tr key={r.id}>
                    <td className="nowrap">{formatTime(r.createdAt)}</td>
                    <td>{exportKindLabel(r)}</td>
                    <td>
                      {agent ? `${included ?? 0} included · ${count(r.manifest, 'withheld') ?? 0} withheld` : included !== null ? `${included} included · ${excluded ?? 0} excluded · ${unavailable ?? 0} unavailable` : '—'}
                    </td>
                    <td className="row">
                      {agent ? (
                        <>
                          <a href={`/export/agent-instructions?run=${r.id}`}>Show</a>
                          <a href={agentFileHref(r.id, 'AGENTS.md')} download="AGENTS.md">AGENTS.md</a>
                          <a href={agentFileHref(r.id, 'CLAUDE.md')} download="CLAUDE.md">CLAUDE.md</a>
                        </>
                      ) : r.kind === 'context_pack' ? (
                        <>
                          <a href={`/export?run=${r.id}`}>Manifest</a>
                          <a href={`/export/${r.id}/markdown`} download>Markdown</a>
                          <a href={`/export/${r.id}/json`} download>JSON</a>
                        </>
                      ) : (
                        <a href={`/export/${r.id}/json`} download>Backup JSON</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
