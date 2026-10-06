import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Prisma } from '../../../generated/client';
import { paginated } from '../../common/pagination';
import {
  ANALYTICS_JOB_NAME,
  ANALYTICS_JOB_RETENTION_MS,
  ANALYTICS_QUEUE_NAME,
} from './analytics.queue';
import type { AnalyticsQueue, AnalyticsQueueJob } from './analytics.queue';
import type {
  AnalyticsRow,
  AnalyticsJobPayload,
  AnalyticsReportType,
  AnalyticsSummary,
} from './analytics.types';
import { buildAnalyticsDateRange } from './analytics-date-range';
import { AnalyticsRowsQueryDto } from './dto/analytics-rows-query.dto';

const decimalValue = /^-?\d+(?:\.\d+)?$/;
const isoDateValue =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

@Injectable()
export class AnalyticsJobsService {
  constructor(
    @InjectQueue(ANALYTICS_QUEUE_NAME) private readonly queue: AnalyticsQueue,
  ) {}

  async submit(
    reportType: AnalyticsReportType,
    query: AnalyticsJobPayload['query'],
  ) {
    buildAnalyticsDateRange(query.dateFrom, query.dateTo);
    const filters: AnalyticsJobPayload['query'] = {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const job = await this.queue.add(ANALYTICS_JOB_NAME, {
      reportType,
      query: filters,
    });
    if (job.id == null)
      throw new Error('Analytics queue did not return a job id');
    return { jobId: String(job.id) };
  }

  async getJobStatus(jobId: string) {
    const job = await this.findJob(jobId);
    const state = this.normalizeState(await job.getState());
    const response: {
      jobId: string;
      reportType: AnalyticsReportType;
      status: 'waiting' | 'active' | 'completed' | 'failed';
      progress: number;
      summary?: AnalyticsSummary;
      totalItems?: number;
      error?: string;
    } = {
      jobId,
      reportType: job.data.reportType,
      status: state,
      progress: this.getProgress(job.progress()),
    };
    if (state === 'completed' && job.returnvalue) {
      response.summary = job.returnvalue.summary;
      response.totalItems = job.returnvalue.data.length;
    }
    if (state === 'failed') response.error = 'Не удалось сформировать отчет.';
    return response;
  }

  async getJobRows(jobId: string, query: AnalyticsRowsQueryDto) {
    const job = await this.getCompletedJob(jobId);
    const { data, reportType } = job.returnvalue!;
    const sortBy =
      query.sortBy ??
      (reportType === 'lessons' ? 'scheduledAt' : 'periodStart');
    if (
      data.length > 0 &&
      !Object.prototype.hasOwnProperty.call(data[0], sortBy)
    )
      throw new BadRequestException('Unsupported report sort field');
    const sortOrder = query.sortOrder.toLowerCase() as 'asc' | 'desc';
    const compareValues = this.getValueComparator(
      data.map((row) => row[sortBy]),
    );
    const sorted = [...data].sort((left, right) => {
      const primary = compareValues(left[sortBy], right[sortBy]);
      const ordered = sortOrder === 'asc' ? primary : -primary;
      return ordered || String(left.id).localeCompare(String(right.id));
    });
    const start = (query.page - 1) * query.limit;
    return paginated(
      sorted.slice(start, start + query.limit),
      data.length,
      query,
      `/api/analytics/jobs/${encodeURIComponent(jobId)}/rows`,
      { sortBy, sortOrder },
      [[sortBy, sortOrder.toUpperCase() as 'ASC' | 'DESC']],
    );
  }

  async getJobExport(jobId: string) {
    const job = await this.getCompletedJob(jobId);
    return {
      reportType: job.returnvalue!.reportType,
      buffer: Buffer.from(job.returnvalue!.exportBase64, 'base64'),
    };
  }

  private async getCompletedJob(jobId: string) {
    const job = await this.findJob(jobId);
    if ((await job.getState()) !== 'completed' || !job.returnvalue) {
      throw new ConflictException('Report is not ready');
    }
    return job;
  }

  private async findJob(jobId: string): Promise<AnalyticsQueueJob> {
    const job = (await this.queue.getJob(jobId)) as AnalyticsQueueJob | null;
    if (!job) throw new NotFoundException('Report job not found');
    if (
      job.finishedOn != null &&
      Date.now() - job.finishedOn >= ANALYTICS_JOB_RETENTION_MS
    ) {
      await job.remove();
      throw new NotFoundException('Report job not found');
    }
    return job;
  }

  private normalizeState(
    state: string,
  ): 'waiting' | 'active' | 'completed' | 'failed' {
    if (state === 'active' || state === 'completed' || state === 'failed')
      return state;
    return 'waiting';
  }

  private getProgress(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  }

  private getValueComparator(
    values: AnalyticsRow[string][],
  ): (left: AnalyticsRow[string], right: AnalyticsRow[string]) => number {
    const presentValues = values.filter((value) => value != null);
    const allMatch = (predicate: (value: AnalyticsRow[string]) => boolean) =>
      presentValues.length > 0 && presentValues.every(predicate);
    let comparePresentValues: (
      left: AnalyticsRow[string],
      right: AnalyticsRow[string],
    ) => number;

    if (
      allMatch((value) => typeof value === 'number') ||
      allMatch((value) => typeof value === 'boolean')
    ) {
      comparePresentValues = (left, right) => Number(left) - Number(right);
    } else if (
      allMatch(
        (value) =>
          value instanceof Date ||
          (typeof value === 'string' && isoDateValue.test(value)),
      )
    ) {
      comparePresentValues = (left, right) => {
        const leftTime =
          left instanceof Date ? left.getTime() : Date.parse(String(left));
        const rightTime =
          right instanceof Date ? right.getTime() : Date.parse(String(right));
        return leftTime - rightTime;
      };
    } else if (
      allMatch((value) => typeof value === 'string' && decimalValue.test(value))
    ) {
      const decimals = new Map<AnalyticsRow[string], Prisma.Decimal>();
      for (const value of presentValues) {
        if (!decimals.has(value)) {
          decimals.set(value, new Prisma.Decimal(String(value)));
        }
      }
      comparePresentValues = (left, right) =>
        decimals.get(left)!.comparedTo(decimals.get(right)!) ?? 0;
    } else {
      comparePresentValues = (left, right) =>
        String(left).localeCompare(String(right));
    }

    return (left, right) => {
      if (left == null || right == null) {
        return left == null ? (right == null ? 0 : -1) : 1;
      }
      return comparePresentValues(left, right);
    };
  }
}
