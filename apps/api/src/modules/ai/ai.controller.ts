// #13 AI endpoints (docs/api.md, "AI-assisted extraction"). With the `off` adapter every one answers 503 ai_disabled.
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  AiExecuteRequest, AiPreviewRequest, type AiExecuteResponse, type AiPreviewResponse, type AiStatusResponse, type AiUsageResponse,
} from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { AiService, requireAiExecute } from './ai.service.js';

@Controller('v1/ai')
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @Get('status')
  status(@Ctx() ctx: RequestContext): AiStatusResponse {
    requireCapability(ctx.actor, 'read');
    return this.ai.status(ctx);
  }

  @Get('usage')
  usage(@Ctx() ctx: RequestContext): Promise<AiUsageResponse> {
    requireCapability(ctx.actor, 'read');
    return this.ai.usage(ctx);
  }

  /** 201: a stored, expiring, single-use preview. Nothing is sent. */
  @Post('preview')
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<AiPreviewResponse> {
    requireCapability(ctx.actor, 'propose');
    return this.ai.preview(ctx, parse(AiPreviewRequest, body));
  }

  /** 200: the provider was called (see `outcome`); candidate records were created when it proposed any. */
  @Post('execute')
  @HttpCode(200)
  execute(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<AiExecuteResponse> {
    requireAiExecute(ctx.actor);
    return this.ai.execute(ctx, parse(AiExecuteRequest, body));
  }
}
