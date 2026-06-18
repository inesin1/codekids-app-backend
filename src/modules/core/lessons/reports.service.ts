import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, LessonStatus } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

@Injectable()
export class ReportsService {
  private readonly bonusAmount: number;
  private readonly bonusWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.bonusAmount = Number(config.get('BONUS_AMOUNT') ?? 50);
    this.bonusWindowMs =
      Number(config.get('BONUS_WINDOW_HOURS') ?? 24) * 60 * 60 * 1000;
  }

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

    const bonusApplied =
      !!lesson.completedAt && this.isWithinBonusWindow(lesson.completedAt);

    return this.prisma.lessonReport.create({
      data: {
        lessonId,
        ...dto,
        bonusApplied,
        bonusAmount: bonusApplied
          ? new Prisma.Decimal(this.bonusAmount)
          : undefined,
      },
    });
  }

  async findByLessonId(lessonId: string) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
    });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  async update(lessonId: string, dto: UpdateReportDto) {
    const report = await this.prisma.lessonReport.findUnique({
      where: { lessonId },
      include: { lesson: { select: { completedAt: true } } },
    });
    if (!report) throw new NotFoundException('Report not found');

    // После закрытия бонус-окна отчёт уже учтён в выплате — правки запрещены
    if (
      report.lesson.completedAt &&
      !this.isWithinBonusWindow(report.lesson.completedAt)
    ) {
      throw new BadRequestException(
        'Report can no longer be edited (bonus window closed)',
      );
    }

    return this.prisma.lessonReport.update({
      where: { lessonId },
      data: dto,
    });
  }

  private isWithinBonusWindow(completedAt: Date): boolean {
    return Date.now() - completedAt.getTime() < this.bonusWindowMs;
  }
}
