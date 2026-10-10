// #19 Agent instructions export routes. GET /v1/exports/:id (ExportsController) serves the stored run document.
import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import { AgentInstructionsRequest, type AgentInstructionsResponse } from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type PoiiResponse, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { AgentInstructionsService } from './agent-instructions.service.js';

@Controller('v1/exports')
export class AgentInstructionsController {
  constructor(@Inject(AgentInstructionsService) private readonly service: AgentInstructionsService) {}

  /** 201. Same capability as context packs: `read`. */
  @Post('agent-instructions')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<AgentInstructionsResponse> {
    requireCapability(ctx.actor, 'read');
    parse(AgentInstructionsRequest, body);
    return this.service.create(ctx);
  }

  /** The generated AGENTS.md or CLAUDE.md, as `text/markdown`. */
  @Get(':id/files/:name')
  async file(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Param('name') name: string, @Res({ passthrough: true }) res: PoiiResponse,
  ): Promise<string> {
    requireCapability(ctx.actor, 'read');
    const file = await this.service.file(ctx, parseId(id), name);
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `inline; filename="${file.name}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    return file.text;
  }
}
