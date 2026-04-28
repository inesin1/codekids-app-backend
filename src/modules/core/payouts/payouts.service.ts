import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, LessonStatus, PayoutStatus } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CalculatePayoutDto } from './dto/calculate-payout.dto';
import { CalculateAllPayoutsDto } from './dto/calculate-all-payouts.dto';

const payoutInclude = {
  teacher: { include: { user: { omit: { password: true } } } },
} as const;

@Injectable()
export class PayoutsService {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(dto: CalculatePayoutDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodStart >= periodEnd) {
      throw new BadRequestException('periodStart must be before periodEnd');
    }

    // Check overlapping payout for this teacher
    const existing = await this.prisma.payout.findFirst({
      where: {
        teacherId: dto.teacherId,
        periodStart: { lt: periodEnd },
        periodEnd: { gt: periodStart },
      },
    });
    if (existing) {
      throw new ConflictException(
        'Payout already exists for overlapping period',
      );
    }

    // Aggregate completed lessons for the teacher in this period
    const lessons = await this.prisma.lesson.findMany({
      where: {
        teacherId: dto.teacherId,
        status: LessonStatus.COMPLETED,
        completedAt: { gte: periodStart, lte: periodEnd },
      },
      include: { report: true },
    });

    const basePay = lessons.reduce(
      (sum, l) => sum.add(l.teacherRate ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    );

    const bonusPay = lessons.reduce((sum, l) => {
      if (l.report?.bonusApplied && l.report.bonusAmount) {
        return sum.add(l.report.bonusAmount);
      }
      return sum;
    }, new Prisma.Decimal(0));

    const totalPay = basePay.add(bonusPay);

    return this.prisma.payout.create({
      data: {
        teacherId: dto.teacherId,
        periodStart,
        periodEnd,
        basePay,
        bonusPay,
        totalPay,
      },
      include: payoutInclude,
    });
  }

  async calculateAll(dto: CalculateAllPayoutsDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodStart >= periodEnd) {
      throw new BadRequestException('periodStart must be before periodEnd');
    }

    // Find all teachers who have completed lessons in this period
    const teacherIds = await this.prisma.lesson
      .findMany({
        where: {
          status: LessonStatus.COMPLETED,
          completedAt: { gte: periodStart, lte: periodEnd },
        },
        select: { teacherId: true },
        distinct: ['teacherId'],
      })
      .then((rows) => rows.map((r) => r.teacherId));

    const results: { created: string[]; skipped: string[] } = {
      created: [],
      skipped: [],
    };

    for (const teacherId of teacherIds) {
      try {
        const payout = await this.calculate({
          teacherId,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
        });
        results.created.push(payout.id);
      } catch (e) {
        if (e instanceof ConflictException) {
          results.skipped.push(teacherId);
          continue;
        }
        throw e;
      }
    }

    return results;
  }

  async findAll(
    filters: {
      teacherId?: string;
      status?: PayoutStatus;
      periodStart?: string;
      periodEnd?: string;
    },
    scope?: { teacherProfileId: string },
  ) {
    const where: Prisma.PayoutWhereInput = {};

    if (filters.teacherId) where.teacherId = filters.teacherId;
    if (filters.status) where.status = filters.status;
    if (filters.periodStart) {
      where.periodStart = { gte: new Date(filters.periodStart) };
    }
    if (filters.periodEnd) {
      where.periodEnd = { lte: new Date(filters.periodEnd) };
    }

    if (scope?.teacherProfileId) {
      where.teacherId = scope.teacherProfileId;
    }

    return this.prisma.payout.findMany({
      where,
      include: payoutInclude,
      orderBy: { periodStart: 'desc' },
    });
  }

  async markPaid(id: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundException('Payout not found');

    if (payout.status !== PayoutStatus.PENDING) {
      throw new BadRequestException(
        `Cannot mark payout with status ${payout.status} as paid`,
      );
    }

    return this.prisma.payout.update({
      where: { id },
      data: { status: PayoutStatus.PAID, paidAt: new Date() },
      include: payoutInclude,
    });
  }
}
