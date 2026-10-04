import { PayoutStatus } from '../../../generated/client';

export type AnalyticsReportType = 'lessons' | 'payouts';

export type AnalyticsQuery = {
  dateFrom: string;
  dateTo: string;
  teacherId?: string;
  studentId?: string;
  status?: PayoutStatus;
};

export type AnalyticsSummary =
  | {
      completedLessonCount: number;
      lessonRevenue: string;
      teacherAccrued: string;
      topUps: string | null;
    }
  | {
      payoutCount: number;
      totalPayout: string;
      paidPayout: string;
      pendingPayout: string;
    };

export type AnalyticsRow = Record<
  string,
  string | number | boolean | Date | null
> & {
  id: string;
};

export type AnalyticsJobResult = {
  reportType: AnalyticsReportType;
  summary: AnalyticsSummary;
  data: AnalyticsRow[];
  exportBase64: string;
};

export type AnalyticsJobPayload = {
  reportType: AnalyticsReportType;
  query: AnalyticsQuery;
};
