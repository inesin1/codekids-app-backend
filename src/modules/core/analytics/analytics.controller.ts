import { Controller, Body, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { AnalyticsJobsService } from './analytics-jobs.service';
import {
  LessonsAnalyticsQueryDto,
  PayoutsAnalyticsQueryDto,
} from './dto/analytics-query.dto';
import { AnalyticsRowsQueryDto } from './dto/analytics-rows-query.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly jobs: AnalyticsJobsService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('lessons/jobs')
  createLessonsJob(@Body() query: LessonsAnalyticsQueryDto) {
    return this.jobs.submit('lessons', query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('payouts/jobs')
  createPayoutsJob(@Body() query: PayoutsAnalyticsQueryDto) {
    return this.jobs.submit('payouts', query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('jobs/:jobId')
  getJobStatus(@Param('jobId') jobId: string) {
    return this.jobs.getJobStatus(jobId);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('jobs/:jobId/rows')
  getJobRows(
    @Param('jobId') jobId: string,
    @Query() query: AnalyticsRowsQueryDto,
  ) {
    return this.jobs.getJobRows(jobId, query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('jobs/:jobId/export')
  async downloadJobExport(
    @Param('jobId') jobId: string,
    @Res() response: Response,
  ) {
    const result = await this.jobs.getJobExport(jobId);
    const name = `analytics-${result.reportType}.xlsx`;
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    response.send(result.buffer);
  }
}
