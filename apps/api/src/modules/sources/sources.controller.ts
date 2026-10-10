import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  AddRevisionRequest, CreateSourceRequest, DeleteSourceRequest, ListSourcesQuery, UpdateSourceRequest,
  type RecordSummary, type RevisionMeta, type RevisionView, type SourceDetail, type SourceView,
  AI_CONTEXT_HEADER, SourceSpanQuery, WITHHELD_HEADER, type SourceSpanView, type WithheldRecord, // #18
} from '@poii/contracts';
import { aiContextRequested } from '../../ai/disclosure.js';
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

  /** #18: in AI context never-send sources are left out and counted in the X-POII-Withheld response header. */
  @Get()
  async list(
    @Ctx() ctx: RequestContext, @Query() query: unknown, @Headers(AI_CONTEXT_HEADER) aiContext: string | undefined,
    @Res({ passthrough: true }) res: PoiiResponse,
  ): Promise<SourceView[]> {
    requireCapability(ctx.actor, 'read');
    const ai = aiContextRequested(aiContext);
    const parsed = parse(ListSourcesQuery, query);
    if (ai) res.setHeader(WITHHELD_HEADER, String(await this.sources.countNeverSend(ctx, parsed)));
    return this.sources.list(ctx, parsed, ai);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string, @Headers(AI_CONTEXT_HEADER) aiContext?: string): Promise<SourceDetail> {
    requireCapability(ctx.actor, 'read');
    return this.sources.get(ctx, parseId(id), aiContextRequested(aiContext));
  }

  @Get(':id/revisions/:revisionId')
  revision(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Param('revisionId') revisionId: string, @Headers(AI_CONTEXT_HEADER) aiContext?: string,
  ): Promise<RevisionView> {
    requireCapability(ctx.actor, 'read');
    return this.sources.getRevision(ctx, parseId(id), parseId(revisionId), aiContextRequested(aiContext));
  }

  /** #18: one span of a revision, with its lines and hash, so a client can quote a citation without the whole text. */
  @Get(':id/revisions/:revisionId/span')
  span(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Param('revisionId') revisionId: string, @Query() query: unknown,
    @Headers(AI_CONTEXT_HEADER) aiContext?: string,
  ): Promise<SourceSpanView> {
    requireCapability(ctx.actor, 'read');
    return this.sources.getSpan(ctx, parseId(id), parseId(revisionId), parse(SourceSpanQuery, query), aiContextRequested(aiContext));
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
  records(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Headers(AI_CONTEXT_HEADER) aiContext?: string,
  ): Promise<Array<RecordSummary | WithheldRecord>> {
    requireCapability(ctx.actor, 'read');
    return this.sources.records(ctx, parseId(id), aiContextRequested(aiContext));
  }
}
