import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ContextPackRequest, type ContextPackResponse, ExportRunView } from '@poii/contracts';
import type { z } from 'zod';
import { requireCapability } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { ExportsService } from './exports.service.js';

@Controller('v1/exports')
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exportsService: ExportsService) {}

  @Post('context-pack')
  contextPack(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ContextPackResponse> {
    requireCapability(ctx.actor, 'read');
    return this.exportsService.contextPack(ctx, parse(ContextPackRequest, body));
  }

  @Get()
  list(@Ctx() ctx: RequestContext): Promise<z.infer<typeof ExportRunView>[]> {
    requireCapability(ctx.actor, 'read');
    return this.exportsService.list(ctx);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<unknown> {
    requireCapability(ctx.actor, 'read');
    return this.exportsService.get(ctx, parseId(id));
  }
}
