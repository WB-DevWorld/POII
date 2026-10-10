import { Controller, Get, Headers, Inject } from '@nestjs/common';
import { AI_CONTEXT_HEADER, type AiCurrentDecision } from '@poii/contracts';
import { aiContextRequested } from '../../ai/disclosure.js';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { ViewsService } from './views.service.js';

@Controller('v1/decisions')
export class ViewsController {
  constructor(@Inject(ViewsService) private readonly views: ViewsService) {}

  @Get('current')
  current(@Ctx() ctx: RequestContext, @Headers(AI_CONTEXT_HEADER) aiContext?: string): Promise<AiCurrentDecision[]> {
    requireCapability(ctx.actor, 'read');
    return this.views.currentDecisions(ctx, aiContextRequested(aiContext)); // #18: AI context
  }
}
