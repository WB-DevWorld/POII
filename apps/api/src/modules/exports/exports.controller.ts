import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { ContextPackRequest, type ContextPackResponse, ExportRunView } from '@poii/contracts';
import { AI_CONTEXT_HEADER, WITHHELD_HEADER } from '@poii/contracts';
import { aiContextRequested, aiNotAllowed } from '../../ai/disclosure.js';
import type { z } from 'zod';
import { requireCapability } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type PoiiResponse, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { ExportsService } from './exports.service.js';

@Controller('v1/exports')
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exportsService: ExportsService) {}

  @Post('context-pack')
  contextPack(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers(AI_CONTEXT_HEADER) aiContext?: string): Promise<ContextPackResponse> {
    requireCapability(ctx.actor, 'read');
    const request = parse(ContextPackRequest, body);
    // #18: an AI context only ever builds packs for destination ai, and must say so.
    if (aiContextRequested(aiContext) && (body as { destination?: unknown } | null)?.destination !== 'ai') {
      throw aiNotAllowed('In AI context a context pack must be built with destination ai', { destination: request.destination });
    }
    return this.exportsService.contextPack(ctx, request);
  }

  /** #18: in AI context only packs an AI may read are listed; the rest are counted in X-POII-Withheld. */
  @Get()
  async list(
    @Ctx() ctx: RequestContext, @Headers(AI_CONTEXT_HEADER) aiContext: string | undefined, @Res({ passthrough: true }) res: PoiiResponse,
  ): Promise<z.infer<typeof ExportRunView>[]> {
    requireCapability(ctx.actor, 'read');
    if (!aiContextRequested(aiContext)) return this.exportsService.list(ctx);
    const { runs, withheld } = await this.exportsService.listForAi(ctx);
    res.setHeader(WITHHELD_HEADER, String(withheld));
    return runs;
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string, @Headers(AI_CONTEXT_HEADER) aiContext?: string): Promise<unknown> {
    requireCapability(ctx.actor, 'read');
    return this.exportsService.get(ctx, parseId(id), aiContextRequested(aiContext));
  }
}
