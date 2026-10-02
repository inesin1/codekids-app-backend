import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, LessonStatus, PayoutStatus } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { CalculatePayoutDto } from './dto/calculate-payout.dto';
import { CalculateAllPayoutsDto } from './dto/calculate-all-payouts.dto';

const payoutInclude = {
  teacher: { include: { user: { omit: { password: true } } } },
} as const;

@Injectable()
export class PayoutsService {
  private readonly bonusWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: TelegramNotifier,
    config: ConfigService,
  ) {
    const bonusWindowHours = Number(config.get('BONUS_WINDOW_HOURS') ?? '24');
    if (!Number.isFinite(bonusWindowHours) || bonusWindowHours < 0) {
      throw new Error(
        'BONUS_WINDOW_HOURS must be a non-negative finite number',
      );
    }
    const bonusWindowMs = bonusWindowHours * 60 * 60 * 1000;
    if (!Number.isFinite(bonusWindowMs)) {
      throw new Error('BONUS_WINDOW_HOURS is too large');
    }
    this.bonusWindowMs = bonusWindowMs;
  }

  /** Рассчитывает и сохраняет выплату преподавателю за указанный период. */
  async calculate(dto: CalculatePayoutDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodStart >= periodEnd) {
      throw new BadRequestException('periodStart must be before periodEnd');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockTeacherProfile(tx, dto.teacherId);

      const now = new Date();
      if (periodEnd > now) {
        throw new BadRequestException('Payout period is not closed');
      }

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

      const lessons = await tx.lesson.findMany({
        where: {
          teacherId: dto.teacherId,
          status: LessonStatus.COMPLETED,
          completedAt: { gte: periodStart, lt: periodEnd },
        },
        include: { report: true },
      });

      if (
        lessons.some(
          (lesson) =>
            !lesson.completedAt ||
            lesson.completedAt.getTime() + this.bonusWindowMs > now.getTime(),
        )
      ) {
        throw new ConflictException(
          'Bonus windows have not closed for all lessons in this period',
        );
      }

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

      let payout: Awaited<ReturnType<typeof tx.payout.create>>;
      try {
        payout = await tx.payout.create({
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

      await this.audit.record(
        {
          action: 'payout.created',
          entityType: 'Payout',
          entityId: payout.id,
          details: {
            teacherId: dto.teacherId,
            periodStart: dto.periodStart,
            periodEnd: dto.periodEnd,
            totalPay: payout.totalPay.toString(),
          },
        },
        tx,
      );
      await this.notifier.payoutChanged(payout.id, tx);
      return payout;
    });
  }

  /** Рассчитывает выплаты за период для всех преподавателей с проведенными уроками. */
  async calculateAll(dto: CalculateAllPayoutsDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodStart >= periodEnd) {
      throw new BadRequestException('periodStart must be before periodEnd');
    }
    if (periodEnd > new Date()) {
      throw new BadRequestException('Payout period is not closed');
    }

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

  /** Возвращает список выплат по заданным фильтрам. */
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

  /** Переводит выплату в статус PAID с фиксацией даты оплаты. */
  async markPaid(id: string) {
    return this.prisma.$transaction(async (tx) => {
      let payout = await tx.payout.findUnique({
        where: { id },
        include: payoutInclude,
      });
      if (!payout) throw new NotFoundException('Payout not found');
      if (payout.status === PayoutStatus.PAID) return payout;

      const paidAt = new Date();
      const changed = await tx.payout.updateMany({
        where: { id, status: PayoutStatus.PENDING },
        data: { status: PayoutStatus.PAID, paidAt },
      });

      if (changed.count === 0) {
        payout = await tx.payout.findUnique({
          where: { id },
          include: payoutInclude,
        });
        if (!payout) throw new NotFoundException('Payout not found');
        if (payout.status === PayoutStatus.PAID) return payout;
        throw new ConflictException('Payout changed before being marked paid');
      }

      const paid = await tx.payout.findUnique({
        where: { id },
        include: payoutInclude,
      });
      if (!paid) throw new NotFoundException('Payout not found');

      await this.audit.record(
        {
          action: 'payout.paid',
          entityType: 'Payout',
          entityId: id,
          details: {
            teacherId: payout.teacherId,
            totalPay: payout.totalPay.toString(),
          },
        },
        tx,
      );
      await this.notifier.payoutChanged(id, tx);
      return paid;
    });
  }

  private async lockTeacherProfile(
    tx: Prisma.TransactionClient,
    teacherId: string,
  ) {
    const profiles = await tx.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "teacher_profiles" WHERE "userId" = ${teacherId} FOR UPDATE
    `;
    if (!profiles.length)
      throw new NotFoundException('Teacher profile not found');
  }
}
