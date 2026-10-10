import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { AI_CONTEXT_HEADER, SearchQuery, type SearchResponse } from '@poii/contracts';
import { aiContextRequested } from '../../ai/disclosure.js';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { SearchService } from './search.service.js';

@Controller('v1/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly searchService: SearchService) {}

  @Get()
  search(@Ctx() ctx: RequestContext, @Query() query: unknown, @Headers(AI_CONTEXT_HEADER) aiContext?: string): Promise<SearchResponse> {
    requireCapability(ctx.actor, 'read');
    return this.searchService.search(ctx, parse(SearchQuery, query), aiContextRequested(aiContext)); // #18: AI context
  }
}
