import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { CreateTokenRequest, type CreatedTokenResponse, type TokenView } from '@poii/contracts';
import { requireAccessManagement } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type PoiiResponse, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { TokensService } from './tokens.service.js';

/** Owner tokens (ADR-0004, ADR-0009). Only the owner person manages them; a token never can. */
@Controller('v1/tokens')
export class TokensController {
  constructor(@Inject(TokensService) private readonly tokens: TokensService) {}

  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: PoiiResponse): Promise<CreatedTokenResponse> {
    requireAccessManagement(ctx.actor);
    const created = await this.tokens.create(ctx, parse(CreateTokenRequest, body));
    res.status(201);
    return created;
  }

  @Get()
  list(@Ctx() ctx: RequestContext): Promise<TokenView[]> {
    requireAccessManagement(ctx.actor);
    return this.tokens.list(ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireAccessManagement(ctx.actor);
    await this.tokens.revoke(ctx, parseId(id));
  }
}
