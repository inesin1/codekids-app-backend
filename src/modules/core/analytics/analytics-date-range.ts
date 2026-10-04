import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { BUSINESS_TIMEZONE } from '../../common/business-time';

export type AnalyticsDateRange = { start: Date; endExclusive: Date };

/** Validates report dates and returns business-day boundaries. */
export function buildAnalyticsDateRange(
  from: string,
  to: string,
): AnalyticsDateRange {
  const start = DateTime.fromISO(from, { zone: BUSINESS_TIMEZONE });
  const end = DateTime.fromISO(to, { zone: BUSINESS_TIMEZONE });
  if (
    !start.isValid ||
    !end.isValid ||
    start.toISODate() !== from ||
    end.toISODate() !== to ||
    end < start
  ) {
    throw new BadRequestException(
      'dateFrom and dateTo must be valid ordered dates',
    );
  }
  return {
    start: start.startOf('day').toJSDate(),
    endExclusive: end.plus({ days: 1 }).startOf('day').toJSDate(),
  };
}
