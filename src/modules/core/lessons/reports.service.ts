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
  private readonly bonusAmount: number;
  private readonly bonusWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: TelegramNotifier,
    config: ConfigService,
  ) {
    this.bonusAmount = Number(config.get('BONUS_AMOUNT') ?? 50);
    this.bonusWindowMs =
      Number(config.get('BONUS_WINDOW_HOURS') ?? 24) * 60 * 60 * 1000;
  }

  /** Создает черновик отчета по проведенному занятию. */
  async create(lessonId: string, dto: CreateReportDto) {
    const lesson = await this.prisma.lesson.findUnique({
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

    const report = await this.prisma.lessonReport.create({
      data: {
        lessonId,
        ...dto,
      },
    });
    this.audit.log({
      action: 'lesson_report.created',
      entityType: 'LessonReport',
      entityId: report.id,
      details: { lessonId },
    });
    return report;
  }

  /** Находит отчет по идентификатору занятия. */
  async findByLessonId(lessonId: string) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
    });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  /** Обновляет отчет, если бонусное окно еще не закрыто. */
  async update(lessonId: string, dto: UpdateReportDto) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
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

    const updated = await this.prisma.lessonReport.update({
      where: { lessonId },
      data: {
        ...dto,
        status: LessonReportStatus.DRAFT,
        sentToTelegram: false,
      },
    });
    this.audit.log({
      action: 'lesson_report.updated',
      entityType: 'LessonReport',
      entityId: report.id,
      details: { lessonId },
    });
    return updated;
  }

  /** Отправляет готовый отчет и его вложения в Telegram. */
  async submit(lessonId: string) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
      include: { lesson: { select: { completedAt: true } } },
    });
    if (!report) throw new NotFoundException('Report not found');

    const firstSubmission = !report.submittedAt;
    const edited =
      report.status === LessonReportStatus.DRAFT && !firstSubmission;
    const bonusApplied =
      report.bonusApplied ||
      (firstSubmission &&
        !!report.lesson.completedAt &&
        this.isWithinBonusWindow(report.lesson.completedAt));
    const submitted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.lessonReport.update({
        where: { id: report.id },
        data: {
          status: LessonReportStatus.SUBMITTED,
          submittedAt: new Date(),
          sentToTelegram: false,
          bonusApplied,
          bonusAmount:
            report.bonusAmount ??
            (bonusApplied ? new Prisma.Decimal(this.bonusAmount) : undefined),
        },
      });
      await this.notifier.queueReport(report.id, edited, tx);
      return updated;
    });
    this.audit.log({
      action: 'lesson_report.submitted',
      entityType: 'LessonReport',
      entityId: report.id,
      details: { lessonId, bonusApplied },
    });
    return submitted;
  }

  /** Проверяет, укладывается ли время сдачи в бонусное окно. */
  private isWithinBonusWindow(completedAt: Date): boolean {
    return Date.now() - completedAt.getTime() < this.bonusWindowMs;
  }
}
