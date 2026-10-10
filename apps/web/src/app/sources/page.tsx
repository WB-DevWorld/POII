import type { Metadata } from 'next';
import type { SourceView } from '@poii/contracts';
import { AiBadge } from '@/components/Badges';
import { PageNotice } from '@/components/PageNotice';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry, query } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';

export const metadata: Metadata = { title: 'Sources' };

const PAGE = 50;

export default async function SourcesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const archivedParam = first(params.archived);
  const archived = archivedParam === 'true' || archivedParam === 'all' ? archivedParam : 'false';
  const offset = Math.max(0, Number(first(params.offset) ?? 0) || 0);
  const result = await apiTry<SourceView[]>(`/v1/sources${query({ archived, limit: PAGE, offset })}`);

  return (
    <section>
      <div className="row spread">
        <h1>Sources</h1>
        <a className="button" href="/sources/new">Add a source</a>
      </div>
      <p className="lede">Originals are kept unchanged. A re-import with different content becomes a new revision.</p>
      <PageNotice notice={params.notice} />
      <form method="get" className="filters" aria-label="Filter sources">
        <label htmlFor="archived">Show</label>
        <select id="archived" name="archived" defaultValue={archived}>
          <option value="false">Active sources</option>
          <option value="true">Archived sources</option>
          <option value="all">All sources</option>
        </select>
        <button type="submit" className="secondary">Apply</button>
      </form>
      {!result.ok ? (
        <ProblemNotice problem={result.problem} title="Sources could not be loaded." />
      ) : result.data.length === 0 ? (
        <p className="muted">No sources here yet. <a href="/sources/new">Add the first one</a>.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="sources-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Kind</th>
                <th scope="col">Created</th>
                <th scope="col">Revisions</th>
                <th scope="col">Records</th>
                <th scope="col">AI</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map(source => (
                <tr key={source.id}>
                  <td>
                    <a href={`/sources/${source.id}`}>{source.title}</a>
                    {source.archivedAt ? <span className="tag warn">archived</span> : null}
                  </td>
                  <td>{source.kind}</td>
                  <td className="nowrap">{formatTime(source.createdAt)}</td>
                  <td>{source.revisionCount}</td>
                  <td>{source.recordCount}</td>
                  <td>
                    <AiBadge allowed={source.aiAllowed} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.ok ? (
        <nav className="row pager" aria-label="Pages">
          {offset > 0 ? <a href={`/sources${query({ archived, offset: Math.max(0, offset - PAGE) })}`}>Previous</a> : null}
          {result.data.length === PAGE ? <a href={`/sources${query({ archived, offset: offset + PAGE })}`}>Next</a> : null}
        </nav>
      ) : null}
    </section>
  );
}
