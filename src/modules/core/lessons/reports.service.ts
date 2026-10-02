import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LessonReportStatus,
  LessonStatus,
  Prisma,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

@Injectable()
export class ReportsService {
  private readonly bonusAmount: Prisma.Decimal;
  private readonly bonusWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: TelegramNotifier,
    config: ConfigService,
  ) {
    const bonusAmount = new Prisma.Decimal(
      config.get<string>('BONUS_AMOUNT') ?? '50',
    );
    if (!bonusAmount.isFinite() || bonusAmount.lt(0)) {
      throw new Error('BONUS_AMOUNT must be a non-negative decimal');
    }
    this.bonusAmount = bonusAmount;

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

  /** Создает черновик отчета по проведенному занятию. */
  async create(lessonId: string, dto: CreateReportDto) {
    return this.prisma.$transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({
        where: { id: lessonId },
        include: { report: true },
      });
      if (!lesson) throw new NotFoundException('Lesson not found');
      if (lesson.status !== LessonStatus.COMPLETED) {
        throw new BadRequestException(
          'Report can only be created for completed lessons',
        );
      }
      if (lesson.report) {
        throw new ConflictException('Report already exists for this lesson');
      }

      const report = await tx.lessonReport.create({
        data: {
          lessonId,
          ...dto,
        },
      });
      await this.audit.record(
        {
          action: 'lesson_report.created',
          entityType: 'LessonReport',
          entityId: report.id,
          details: { lessonId },
        },
        tx,
      );
      return report;
    });
  }

  /** Находит отчет по идентификатору занятия. */
  async findByLessonId(lessonId: string, hideInternalNotes = false) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
    });
    if (!report) throw new NotFoundException('Report not found');
    return hideInternalNotes ? { ...report, extraNotes: null } : report;
  }

  /** Обновляет отчет, если бонусное окно еще не закрыто. */
  async update(lessonId: string, dto: UpdateReportDto) {
    return this.prisma.$transaction(async (tx) => {
      const identity = await tx.lessonReport.findUnique({
        where: { lessonId },
        select: { id: true },
      });
      if (!identity) throw new NotFoundException('Report not found');

      await tx.$queryRaw`
        SELECT "id" FROM "lesson_reports" WHERE "id" = ${identity.id} FOR UPDATE
      `;
      const report = await tx.lessonReport.findUnique({
        where: { id: identity.id },
        include: { lesson: { select: { completedAt: true } } },
      });
      if (!report) throw new NotFoundException('Report not found');

      // после закрытия бонус-окна правки запрещены
      if (
        report.lesson.completedAt &&
        !this.isWithinBonusWindow(report.lesson.completedAt)
      ) {
        throw new BadRequestException(
          'Report can no longer be edited (bonus window closed)',
        );
      }

      const updated = await tx.lessonReport.update({
        where: { id: report.id },
        data: {
          ...dto,
          status: LessonReportStatus.DRAFT,
          sentToTelegram: false,
        },
      });
      await this.audit.record(
        {
          action: 'lesson_report.updated',
          entityType: 'LessonReport',
          entityId: report.id,
          details: { lessonId },
        },
        tx,
      );
      return updated;
    });
  }

  /** Отправляет готовый отчет и его вложения в Telegram. */
  async submit(lessonId: string) {
    return this.prisma.$transaction(async (tx) => {
      const identity = await tx.lessonReport.findUnique({
        where: { lessonId },
        select: { id: true, lesson: { select: { teacherId: true } } },
      });
      if (!identity) throw new NotFoundException('Report not found');

      await this.lockTeacherProfile(tx, identity.lesson.teacherId);
      await tx.$queryRaw`
        SELECT "id" FROM "lesson_reports" WHERE "id" = ${identity.id} FOR UPDATE
      `;
      const report = await tx.lessonReport.findUnique({
        where: { id: identity.id },
        include: {
          lesson: {
            select: { teacherId: true, status: true, completedAt: true },
          },
        },
      });
      if (!report) throw new NotFoundException('Report not found');
      if (report.lesson.teacherId !== identity.lesson.teacherId) {
        throw new ConflictException(
          'Lesson teacher changed while submitting report',
        );
      }
      if (report.lesson.status !== LessonStatus.COMPLETED) {
        throw new BadRequestException(
          'Report can only be submitted for completed lessons',
        );
      }
      if (
        report.status === LessonReportStatus.SUBMITTED &&
        report.submittedAt
      ) {
        const unchanged = await tx.lessonReport.findUnique({
          where: { id: report.id },
        });
        if (!unchanged) throw new NotFoundException('Report not found');
        return unchanged;
      }

      const firstSubmission = !report.submittedAt;
      const edited = !firstSubmission;
      let awardBonus = false;
      if (
        firstSubmission &&
        report.lesson.completedAt &&
        this.isWithinBonusWindow(report.lesson.completedAt)
      ) {
        const finalizedPayout = await tx.payout.findFirst({
          where: {
            teacherId: report.lesson.teacherId,
            periodStart: { lte: report.lesson.completedAt },
            periodEnd: { gt: report.lesson.completedAt },
          },
          select: { id: true },
        });
        awardBonus = !finalizedPayout;
      }

      const bonusApplied = report.bonusApplied || awardBonus;
      const updated = await tx.lessonReport.update({
        where: { id: report.id },
        data: {
          status: LessonReportStatus.SUBMITTED,
          submittedAt: new Date(),
          sentToTelegram: false,
          bonusApplied,
          bonusAmount:
            report.bonusAmount ?? (awardBonus ? this.bonusAmount : undefined),
        },
      });
      await this.notifier.queueReport(report.id, edited, tx);
      await this.audit.record(
        {
          action: 'lesson_report.submitted',
          entityType: 'LessonReport',
          entityId: report.id,
          details: { lessonId, bonusApplied },
        },
        tx,
      );
      return updated;
    });
  }

  /** Проверяет, укладывается ли время сдачи в бонусное окно. */
  private isWithinBonusWindow(completedAt: Date): boolean {
    return Date.now() - completedAt.getTime() < this.bonusWindowMs;
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
