import { Controller, Get, Inject } from '@nestjs/common';
import type { CurrentDecision } from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { ViewsService } from './views.service.js';

@Controller('v1/decisions')
export class ViewsController {
  constructor(@Inject(ViewsService) private readonly views: ViewsService) {}

  @Get('current')
  current(@Ctx() ctx: RequestContext): Promise<CurrentDecision[]> {
    requireCapability(ctx.actor, 'read');
    return this.views.currentDecisions(ctx);
  }
}
