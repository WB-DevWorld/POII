import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  AddRevisionRequest, CreateSourceRequest, DeleteSourceRequest, ListSourcesQuery, UpdateSourceRequest,
  type RecordSummary, type RevisionMeta, type RevisionView, type SourceDetail, type SourceView,
} from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type PoiiResponse, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { SourcesService } from './sources.service.js';

@Controller('v1/sources')
export class SourcesController {
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  /** 201 when created; 200 with deduplicated: true when an identical source already exists. */
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: PoiiResponse): Promise<SourceView> {
    requireCapability(ctx.actor, 'propose');
    const { view, created } = await this.sources.create(ctx, parse(CreateSourceRequest, body));
    res.status(created ? 201 : 200);
    return view;
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<SourceView[]> {
    requireCapability(ctx.actor, 'read');
    return this.sources.list(ctx, parse(ListSourcesQuery, query));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<SourceDetail> {
    requireCapability(ctx.actor, 'read');
    return this.sources.get(ctx, parseId(id));
  }

  @Get(':id/revisions/:revisionId')
  revision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('revisionId') revisionId: string): Promise<RevisionView> {
    requireCapability(ctx.actor, 'read');
    return this.sources.getRevision(ctx, parseId(id), parseId(revisionId));
  }

  /** 201 for a new revision; 200 with the existing revision when the content is identical. */
  @Post(':id/revisions')
  async addRevision(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: PoiiResponse,
  ): Promise<RevisionMeta> {
    requireCapability(ctx.actor, 'propose');
    const { meta, created } = await this.sources.addRevision(ctx, parseId(id), parse(AddRevisionRequest, body));
    res.status(created ? 201 : 200);
    return meta;
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<SourceView> {
    requireCapability(ctx.actor, 'propose');
    return this.sources.update(ctx, parseId(id), parse(UpdateSourceRequest, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    requireCapability(ctx.actor, 'delete');
    await this.sources.remove(ctx, parseId(id), parse(DeleteSourceRequest, body));
  }

  @Get(':id/records')
  records(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<RecordSummary[]> {
    requireCapability(ctx.actor, 'read');
    return this.sources.records(ctx, parseId(id));
  }
}
