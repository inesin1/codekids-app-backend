import { BadRequestException } from '@nestjs/common';
import { Prisma, PayoutStatus } from '../../../generated/client';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  const prisma = {
    lesson: {
      findMany: jest.fn(),
    },
    payment: { aggregate: jest.fn() },
    payout: {
      findMany: jest.fn(),
    },
  };
  const service = new AnalyticsService(prisma as never);

  beforeEach(() => jest.resetAllMocks());

  it('uses business-day boundaries and exact Decimal sums over a full year', async () => {
    prisma.lesson.findMany.mockResolvedValueOnce([createLessonRow()]);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { amount: new Prisma.Decimal('15.05') },
    });

    const result = await service.exportLessons({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      page: 1,
      limit: 20,
    });

    const lessonFindManyCalls = prisma.lesson.findMany.mock
      .calls as unknown as [{ where: Record<string, unknown> }][];
    expect(lessonFindManyCalls[0][0].where).toMatchObject({
      scheduledAt: {
        gte: new Date('2025-12-31T21:00:00.000Z'),
        lt: new Date('2026-12-31T21:00:00.000Z'),
      },
    });
    expect(result.summary).toEqual({
      completedLessonCount: 1,
      lessonRevenue: '10.1',
      teacherAccrued: '8.3',
      topUps: '15.05',
    });
  });

  it('applies teacher and student filters while hiding topups whenever a teacher is filtered', async () => {
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    await service.exportLessons({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-01',
      teacherId: 't1',
      page: 1,
      limit: 20,
    });
    const lessonFindManyCalls = prisma.lesson.findMany.mock
      .calls as unknown as [{ where: Record<string, unknown> }][];
    expect(lessonFindManyCalls[0][0].where).toMatchObject({
      teacherId: 't1',
    });
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();

    prisma.lesson.findMany.mockResolvedValueOnce([]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    await service.exportLessons({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-01',
      teacherId: 't1',
      studentId: 's1',
      page: 1,
      limit: 20,
    });
    expect(lessonFindManyCalls[1][0].where).toMatchObject({
      teacherId: 't1',
      studentId: 's1',
    });
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();

    prisma.lesson.findMany.mockResolvedValueOnce([]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    await service.exportLessons({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-01',
      studentId: 's1',
      page: 1,
      limit: 20,
    });
    const paymentAggregateCalls = prisma.payment.aggregate.mock
      .calls as unknown as [{ where: Record<string, unknown> }][];
    expect(paymentAggregateCalls[0][0].where).toMatchObject({
      studentId: 's1',
    });
  });

  it('rejects reversed and impossible dates', async () => {
    await expect(
      service.exportLessons({
        dateFrom: '2026-10-02',
        dateTo: '2026-10-01',
        page: 1,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.exportLessons({
        dateFrom: '2026-02-30',
        dateTo: '2026-03-01',
        page: 1,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('contains complete payout periods and summarizes the selected status exactly', async () => {
    const payout = {
      id: 'p1',
      teacherId: 't1',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
      basePay: new Prisma.Decimal('10.10'),
      bonusPay: new Prisma.Decimal('0.20'),
      totalPay: new Prisma.Decimal('10.30'),
      status: PayoutStatus.PAID,
      paidAt: null,
      teacher: { user: { firstName: 'Teacher', lastName: 'One' } },
    };
    prisma.payout.findMany.mockResolvedValue([payout]);
    const result = await service.exportPayouts({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      teacherId: 't1',
      status: PayoutStatus.PAID,
      page: 1,
      limit: 20,
    });
    const payoutFindManyCalls = prisma.payout.findMany.mock
      .calls as unknown as [{ where: Record<string, unknown> }][];
    expect(payoutFindManyCalls[0][0].where).toEqual({
      periodStart: { gte: new Date('2025-12-31T21:00:00.000Z') },
      periodEnd: { lte: new Date('2026-12-31T21:00:00.000Z') },
      teacherId: 't1',
      status: PayoutStatus.PAID,
    });
    expect(result.summary).toEqual({
      payoutCount: 1,
      totalPayout: '10.3',
      paidPayout: '10.3',
      pendingPayout: '0',
    });
  });
  it('summarizes mixed payout statuses from the exported rows', async () => {
    const payout = {
      teacherId: 't1',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
      basePay: new Prisma.Decimal('0.10'),
      bonusPay: new Prisma.Decimal('0'),
      paidAt: null,
      teacher: { user: { firstName: 'Teacher', lastName: 'One' } },
    };
    prisma.payout.findMany.mockResolvedValue([
      {
        ...payout,
        id: 'p1',
        status: PayoutStatus.PAID,
        totalPay: new Prisma.Decimal('0.10'),
      },
      {
        ...payout,
        id: 'p2',
        status: PayoutStatus.PENDING,
        totalPay: new Prisma.Decimal('0.20'),
      },
      {
        ...payout,
        id: 'p3',
        status: PayoutStatus.PAID,
        totalPay: new Prisma.Decimal('0.30'),
      },
    ]);
    const result = await service.exportPayouts({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      page: 1,
      limit: 20,
    });
    expect(result.data).toHaveLength(3);
    expect(result.summary).toEqual({
      payoutCount: 3,
      totalPayout: '0.6',
      paidPayout: '0.4',
      pendingPayout: '0.2',
    });
  });

  it('returns zero totals for an empty payout report', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    const result = await service.exportPayouts({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      page: 1,
      limit: 20,
    });
    expect(result.summary).toEqual({
      payoutCount: 0,
      totalPayout: '0',
      paidPayout: '0',
      pendingPayout: '0',
    });
  });
});

function createLessonRow() {
  return {
    id: 'l1',
    scheduledAt: new Date('2026-06-15T10:00:00.000Z'),
    completedAt: new Date('2026-06-15T10:30:00.000Z'),
    durationMinutes: 60,
    teacherId: 't1',
    studentId: 's1',
    price: new Prisma.Decimal('10.10'),
    teacherRate: new Prisma.Decimal('8.10'),
    teacher: { user: { firstName: 'Teacher', lastName: 'One' } },
    student: { user: { firstName: 'Student', lastName: 'One' } },
    enrollment: { course: { name: 'Math' } },
    report: { bonusApplied: true, bonusAmount: new Prisma.Decimal('0.20') },
  };
}
