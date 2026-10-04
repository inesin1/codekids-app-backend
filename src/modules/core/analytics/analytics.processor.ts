import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { AnalyticsService } from './analytics.service';
import { createAnalyticsWorkbook } from './analytics.xlsx';
import { ANALYTICS_JOB_NAME, ANALYTICS_QUEUE_NAME } from './analytics.queue';
import type {
  AnalyticsJobPayload,
  AnalyticsJobResult,
} from './analytics.types';

@Processor(ANALYTICS_QUEUE_NAME)
export class AnalyticsProcessor {
  constructor(private readonly analytics: AnalyticsService) {}

  @Process(ANALYTICS_JOB_NAME)
  async process(job: Job<AnalyticsJobPayload>): Promise<AnalyticsJobResult> {
    await job.progress(5);
    const query = { ...job.data.query, page: 1, limit: 100 };
    const report =
      job.data.reportType === 'lessons'
        ? await this.analytics.exportLessons(query)
        : await this.analytics.exportPayouts(query);
    await job.progress(75);
    const xlsx = await createAnalyticsWorkbook(
      job.data.reportType,
      report.summary,
      report.data,
      job.data.query.dateFrom,
      job.data.query.dateTo,
    );
    await job.progress(100);
    return {
      reportType: job.data.reportType,
      summary: report.summary,
      data: report.data,
      exportBase64: xlsx.toString('base64'),
    };
  }
}
