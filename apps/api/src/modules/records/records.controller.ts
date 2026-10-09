import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ConfirmRecordRequest, CreateRecordRequest, EvidenceInput, ListRecordsQuery, RejectRecordRequest, SetStatusRequest,
  SupersedeRecordRequest, UpdateRecordRequest,
  type RecordDetail, type RecordSummary,
} from '@poii/contracts';
import { requireCapability } from '../../authorization/authorization.js';
import { parseId } from '../../common/params.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { parse } from '../../common/util.js';
import { RecordsService } from './records.service.js';

@Controller('v1/records')
export class RecordsController {
  constructor(@Inject(RecordsService) private readonly records: RecordsService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.create(ctx, parse(CreateRecordRequest, body));
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<RecordSummary[]> {
    requireCapability(ctx.actor, 'read');
    return this.records.list(ctx, parse(ListRecordsQuery, query));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'read');
    return this.records.get(ctx, parseId(id));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.update(ctx, parseId(id), parse(UpdateRecordRequest, body));
  }

  @Post(':id/evidence')
  @HttpCode(200)
  addEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.addEvidence(ctx, parseId(id), parse(EvidenceInput, body));
  }

  @Delete(':id/evidence/:evidenceId')
  @HttpCode(200)
  removeEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('evidenceId') evidenceId: string): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.removeEvidence(ctx, parseId(id), parseId(evidenceId));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'confirm');
    return this.records.confirm(ctx, parseId(id), parse(ConfirmRecordRequest, body));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'confirm');
    return this.records.reject(ctx, parseId(id), parse(RejectRecordRequest, body));
  }

  @Post(':id/status')
  @HttpCode(200)
  status(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.setStatus(ctx, parseId(id), parse(SetStatusRequest, body));
  }

  @Post(':id/supersede')
  supersede(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.records.supersede(ctx, parseId(id), parse(SupersedeRecordRequest, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireCapability(ctx.actor, 'delete');
    await this.records.remove(ctx, parseId(id));
  }
}
