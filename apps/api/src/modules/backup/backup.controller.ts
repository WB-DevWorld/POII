import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { RestoreRequest, type BackupDocument, type RestoreResponse } from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { BackupService } from './backup.service.js';

@Controller('v1')
export class BackupController {
  constructor(@Inject(BackupService) private readonly backupService: BackupService) {}

  @Post('backup')
  @HttpCode(200)
  backup(@Ctx() ctx: RequestContext): Promise<BackupDocument> {
    requireCapability(ctx.actor, 'confirm');
    return this.backupService.backup(ctx);
  }

  @Post('restore')
  @HttpCode(200)
  restore(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<RestoreResponse> {
    requireCapability(ctx.actor, 'delete');
    return this.backupService.restore(ctx, parse(RestoreRequest, body).backup);
  }
}
