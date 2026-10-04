import type { Job, Queue } from 'bull';
import type {
  AnalyticsJobPayload,
  AnalyticsJobResult,
} from './analytics.types';

export const ANALYTICS_QUEUE_NAME = 'analytics-reports';
export const ANALYTICS_JOB_NAME = 'generate-report';
export const ANALYTICS_JOB_RETENTION_MS = 60 * 60 * 1000;

export type AnalyticsQueue = Queue<AnalyticsJobPayload>;
export type AnalyticsQueueJob = Omit<
  Job<AnalyticsJobPayload>,
  'returnvalue'
> & {
  returnvalue?: AnalyticsJobResult;
};
