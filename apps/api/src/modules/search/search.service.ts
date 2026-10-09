import { Inject, Injectable } from '@nestjs/common';
import type { SearchQuery, SearchResponse } from '@poii/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { RequestContext } from '../../common/request-context.js';
import { DB } from '../../common/tokens.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { findFirstSpan, safeHeadline } from '../../domain/search-span.js';

type Search = z.output<typeof SearchQuery>;

// Highlights are marked with control characters, then HTML-escaped and turned into <b> (see safeHeadline).
const HEADLINE_OPTIONS = sql`'StartSel=' || chr(2) || ', StopSel=' || chr(3) || ', MaxWords=35, MinWords=12, MaxFragments=2'`;

type SourceHit = { id: string; title: string; revision_id: string; content_text: string; rank: number; headline: string };
type RecordHit = { id: string; title: string; kind: string; review_state: 'candidate' | 'confirmed' | 'rejected'; rank: number; headline: string };

@Injectable()
export class SearchService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** websearch_to_tsquery over current source revisions and records. Deleted sources have no rows to match. */
  async search(ctx: RequestContext, query: Search): Promise<SearchResponse> {
    requireCapability(ctx.actor, 'read');
    const ws = ctx.workspace.id;
    const sources = await this.db.orm.execute<SourceHit>(sql`
      WITH q AS (SELECT websearch_to_tsquery('english', ${query.q}) AS query)
      SELECT s.id, s.title, r.id AS revision_id, r.content_text, ts_rank(r.search_vector, q.query)::float8 AS rank,
             ts_headline('english', r.content_text, q.query, ${HEADLINE_OPTIONS}) AS headline
      FROM q, source s
      JOIN LATERAL (SELECT sr.id, sr.content_text, sr.search_vector FROM source_revision sr
                    WHERE sr.source_id = s.id ORDER BY sr.revision_no DESC LIMIT 1) r ON true
      WHERE s.workspace_id = ${ws} AND r.search_vector @@ q.query
      ORDER BY rank DESC, s.id LIMIT ${query.limit}`);
    const records = await this.db.orm.execute<RecordHit>(sql`
      WITH q AS (SELECT websearch_to_tsquery('english', ${query.q}) AS query)
      SELECT r.id, r.title, r.kind::text AS kind, r.review_state::text AS review_state,
             ts_rank(r.search_vector, q.query)::float8 AS rank,
             ts_headline('english', r.title || ' ' || r.body, q.query, ${HEADLINE_OPTIONS}) AS headline
      FROM q, record r
      WHERE r.workspace_id = ${ws} AND r.search_vector @@ q.query
      ORDER BY rank DESC, r.id LIMIT ${query.limit}`);
    const hits: SearchResponse['hits'] = [
      ...sources.rows.map(row => {
        const span = findFirstSpan(row.content_text, query.q);
        return {
          type: 'source' as const,
          id: row.id,
          title: row.title,
          headline: safeHeadline(row.headline),
          rank: Number(row.rank),
          span: span ? { revisionId: row.revision_id, ...span } : null,
          reviewState: null,
          kind: null,
        };
      }),
      ...records.rows.map(row => ({
        type: 'record' as const,
        id: row.id,
        title: row.title,
        headline: safeHeadline(row.headline),
        rank: Number(row.rank),
        span: null,
        reviewState: row.review_state,
        kind: row.kind,
      })),
    ];
    hits.sort((a, b) => b.rank - a.rank);
    return { query: query.q, hits: hits.slice(0, query.limit) };
  }
}
