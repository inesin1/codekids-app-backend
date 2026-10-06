import { Injectable } from '@nestjs/common';
import { Prisma, LessonStatus, PayoutStatus } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  LessonsAnalyticsQueryDto,
  PayoutsAnalyticsQueryDto,
} from './dto/analytics-query.dto';
import { buildAnalyticsDateRange } from './analytics-date-range';
import type { AnalyticsDateRange } from './analytics-date-range';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async exportLessons(query: LessonsAnalyticsQueryDto) {
    const range = buildAnalyticsDateRange(query.dateFrom, query.dateTo);
    const where = this.buildLessonWhere(query, range);
    const topupWhere = this.buildTopupWhere(query, range);
    const [lessons, topups] = await Promise.all([
      this.prisma.lesson.findMany({
        where,
        select: {
          id: true,
          scheduledAt: true,
          completedAt: true,
          durationMinutes: true,
          teacherId: true,
          teacher: {
            select: {
              user: { select: { firstName: true, lastName: true } },
            },
          },
          studentId: true,
          student: {
            select: {
              user: { select: { firstName: true, lastName: true } },
            },
          },
          enrollment: {
            select: { course: { select: { name: true } } },
          },
          price: true,
          teacherRate: true,
          report: { select: { bonusApplied: true, bonusAmount: true } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      }),
      topupWhere
        ? this.prisma.payment.aggregate({
            where: topupWhere,
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null } }),
    ]);
    const data = lessons.map((lesson) => ({
      id: lesson.id,
      scheduledAt: lesson.scheduledAt,
      completedAt: lesson.completedAt!,
      durationMinutes: lesson.durationMinutes,
      teacherId: lesson.teacherId,
      teacherName:
        `${lesson.teacher.user.firstName} ${lesson.teacher.user.lastName}`.trim(),
      studentId: lesson.studentId,
      studentName:
        `${lesson.student.user.firstName} ${lesson.student.user.lastName}`.trim(),
      price: lesson.price?.toString() ?? '0',
      teacherRate: lesson.teacherRate?.toString() ?? null,
      bonusApplied: lesson.report?.bonusApplied ?? false,
      bonusAmount:
        lesson.report?.bonusApplied && lesson.report.bonusAmount
          ? lesson.report.bonusAmount.toString()
          : '0',
      courseName: lesson.enrollment.course.name,
    }));
    const zero = new Prisma.Decimal(0);
    const revenue = lessons.reduce((sum, l) => sum.add(l.price ?? zero), zero);
    const base = lessons.reduce(
      (sum, l) => sum.add(l.teacherRate ?? zero),
      zero,
    );
    const bonus = lessons.reduce((sum, l) => {
      const amount = l.report?.bonusAmount;
      return l.report?.bonusApplied && amount ? sum.add(amount) : sum;
    }, zero);
    return {
      summary: {
        completedLessonCount: lessons.length,
        lessonRevenue: revenue.toString(),
        teacherAccrued: base.add(bonus).toString(),
        topUps: topupWhere ? (topups._sum.amount ?? zero).toString() : null,
      },
      data,
    };
  }

  async exportPayouts(query: PayoutsAnalyticsQueryDto) {
    const range = buildAnalyticsDateRange(query.dateFrom, query.dateTo);
    const where = this.buildPayoutWhere(query, range);
    const data = await this.prisma.payout.findMany({
      where,
      select: {
        id: true,
        teacherId: true,
        teacher: {
          select: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        periodStart: true,
        periodEnd: true,
        basePay: true,
        bonusPay: true,
        totalPay: true,
        status: true,
        paidAt: true,
      },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
    });
    return {
      summary: this.summarizePayouts(data),
      data: data.map((payout) => ({
        id: payout.id,
        teacherId: payout.teacherId,
        teacherName:
          `${payout.teacher.user.firstName} ${payout.teacher.user.lastName}`.trim(),
        periodStart: payout.periodStart,
        periodEnd: payout.periodEnd,
        basePay: payout.basePay.toString(),
        bonusPay: payout.bonusPay.toString(),
        totalPay: payout.totalPay.toString(),
        status: payout.status,
        paidAt: payout.paidAt,
      })),
    };
  }

  private buildLessonWhere(
    query: LessonsAnalyticsQueryDto,
    range: AnalyticsDateRange,
  ): Prisma.LessonWhereInput {
    return {
      status: LessonStatus.COMPLETED,
      scheduledAt: { gte: range.start, lt: range.endExclusive },
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
    };
  }

  private buildTopupWhere(
    query: LessonsAnalyticsQueryDto,
    range: AnalyticsDateRange,
  ): Prisma.PaymentWhereInput | null {
    if (query.teacherId) return null;
    return {
      paidAt: { gte: range.start, lt: range.endExclusive },
      ...(query.studentId ? { studentId: query.studentId } : {}),
    };
  }

  private buildPayoutWhere(
    query: PayoutsAnalyticsQueryDto,
    range: AnalyticsDateRange,
  ): Prisma.PayoutWhereInput {
    return {
      periodStart: { gte: range.start },
      periodEnd: { lte: range.endExclusive },
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
  }

  private summarizePayouts(
    rows: Array<{ status: PayoutStatus; totalPay: Prisma.Decimal }>,
  ) {
    let total = new Prisma.Decimal(0);
    let paid = new Prisma.Decimal(0);
    let pending = new Prisma.Decimal(0);
    for (const row of rows) {
      total = total.add(row.totalPay);
      if (row.status === PayoutStatus.PAID) paid = paid.add(row.totalPay);
      if (row.status === PayoutStatus.PENDING)
        pending = pending.add(row.totalPay);
    }
    return {
      payoutCount: rows.length,
      totalPayout: total.toString(),
      paidPayout: paid.toString(),
      pendingPayout: pending.toString(),
    };
  }
}
