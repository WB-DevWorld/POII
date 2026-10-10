import { Controller, Get, Inject, Query } from '@nestjs/common';
import { SearchQuery, type SearchResponse } from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { SearchService } from './search.service.js';

@Controller('v1/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly searchService: SearchService) {}

  @Get()
  search(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<SearchResponse> {
    requireCapability(ctx.actor, 'read');
    return this.searchService.search(ctx, parse(SearchQuery, query));
  }
}
