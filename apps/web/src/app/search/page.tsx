import type { Metadata } from 'next';
import type { SearchResponse } from '@poii/contracts';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry, query } from '@/lib/api';
import { headlineParts } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';
import { spanHref } from '@/lib/offsets';

export const metadata: Metadata = { title: 'Search' };

type Hit = SearchResponse['hits'][number];

function Headline({ text }: { text: string }) {
  return (
    <p className="headline">
      {headlineParts(text).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </p>
  );
}

function hitHref(hit: Hit): string {
  if (hit.type === 'record') return `/records/${hit.id}`;
  return hit.span ? spanHref(hit.id, hit.span.revisionId, hit.span.startChar, hit.span.endChar) : `/sources/${hit.id}`;
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = (first(sp.q) ?? '').trim().slice(0, 500);
  const result = q ? await apiTry<SearchResponse>(`/v1/search${query({ q, limit: 50 })}`) : null;
  const hits = result?.ok ? result.data.hits : [];
  const sources = hits.filter(h => h.type === 'source');
  const records = hits.filter(h => h.type === 'record');

  return (
    <section>
      <h1>Search</h1>
      <form method="get" role="search" className="search-form" aria-label="Search sources and records">
        <label htmlFor="q" className="visually-hidden">Search</label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder='Words, "a phrase", or -exclude' maxLength={500} />
        <button type="submit">Search</button>
      </form>
      <p className="hint">Full-text search over the current revision of every source and over every record. Deleted sources never appear.</p>
      {result && !result.ok ? <ProblemNotice problem={result.problem} title="Search failed." /> : null}
      {result?.ok && hits.length === 0 ? <p className="muted">Nothing found for “{q}”.</p> : null}
      {sources.length ? (
        <>
          <h2>Sources ({sources.length})</h2>
          <ul className="hits" data-testid="source-hits">
            {sources.map(hit => (
              <li key={`s-${hit.id}`}>
                <a href={hitHref(hit)} data-testid="source-hit">{hit.title}</a>
                {hit.span ? <span className="hint"> · opens at line {hit.span.startLine}</span> : null}
                <Headline text={hit.headline} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {records.length ? (
        <>
          <h2>Records ({records.length})</h2>
          <ul className="hits" data-testid="record-hits">
            {records.map(hit => (
              <li key={`r-${hit.id}`}>
                <a href={hitHref(hit)} data-testid="record-hit">{hit.title}</a>{' '}
                {hit.kind ? <span className="tag">{hit.kind}</span> : null}
                {hit.reviewState ? <span className={`tag${hit.reviewState === 'confirmed' ? ' ok' : hit.reviewState === 'rejected' ? ' danger' : ' warn'}`}>{hit.reviewState}</span> : null}
                <Headline text={hit.headline} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
