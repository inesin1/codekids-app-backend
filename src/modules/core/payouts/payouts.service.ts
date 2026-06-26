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

    return this.prisma.$transaction(async (tx) => {
      // Check overlapping payout for this teacher
      const existing = await tx.payout.findFirst({
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

      // Aggregate completed lessons for the teacher in this period [start, end)
      const lessons = await tx.lesson.findMany({
        where: {
          teacherId: dto.teacherId,
          status: LessonStatus.COMPLETED,
          completedAt: { gte: periodStart, lt: periodEnd },
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

      try {
        return await tx.payout.create({
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
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          throw new ConflictException('Payout already exists for this period');
        }
        throw e;
      }
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
          completedAt: { gte: periodStart, lt: periodEnd },
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
    scope?: { teacherUserId: string },
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

    if (scope?.teacherUserId) {
      where.teacherId = scope.teacherUserId;
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
