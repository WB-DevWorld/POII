import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { CreateActorRequest, type ActorView, type MeResponse } from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { IdentityService } from './identity.service.js';

@Controller('v1')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get('me')
  me(@Ctx() ctx: RequestContext): MeResponse {
    requireCapability(ctx.actor, 'read');
    return this.identity.me(ctx);
  }

  @Get('actors')
  actors(@Ctx() ctx: RequestContext): Promise<ActorView[]> {
    requireCapability(ctx.actor, 'read');
    return this.identity.listActors(ctx);
  }

  @Post('actors')
  createActor(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ActorView> {
    requireCapability(ctx.actor, 'propose');
    return this.identity.createActor(ctx, parse(CreateActorRequest, body));
  }
}
