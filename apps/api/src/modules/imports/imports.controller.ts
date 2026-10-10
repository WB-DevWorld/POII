// #20 conversation import: HTTP surface. The export file travels as JSON (`file` = the parsed conversations.json),
// bounded by the API's JSON body limit; see docs/conversation-import.md.
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import {
  ConversationImportRequest, ConversationPreviewRequest, MessageAttributionQuery,
  type ConversationImportResponse, type ConversationPreviewResponse, type MessageAttributionResponse,
} from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { ImportsService } from './imports.service.js';

@Controller('v1/imports/conversations')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  /** Lists the conversations in the file. Stores nothing. */
  @Post('preview')
  @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ConversationPreviewResponse> {
    requireCapability(ctx.actor, 'read');
    return this.imports.preview(ctx, parse(ConversationPreviewRequest, body));
  }

  /** Imports exactly the selected conversations; per-conversation outcomes in the body. */
  @Post()
  @HttpCode(200)
  importSelected(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ConversationImportResponse> {
    requireCapability(ctx.actor, 'propose');
    return this.imports.importSelected(ctx, parse(ConversationImportRequest, body));
  }

  @Get('attribution')
  attribution(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<MessageAttributionResponse> {
    requireCapability(ctx.actor, 'read');
    return this.imports.attribution(ctx, parse(MessageAttributionQuery, query));
  }
}
