import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, LessonStatus } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

const BONUS_AMOUNT = 50;
const BONUS_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

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
      !!lesson.completedAt &&
      Date.now() - lesson.completedAt.getTime() < BONUS_WINDOW_MS;

    return this.prisma.lessonReport.create({
      data: {
        lessonId,
        ...dto,
        bonusApplied,
        bonusAmount: bonusApplied
          ? new Prisma.Decimal(BONUS_AMOUNT)
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
    await this.findByLessonId(lessonId);
    return this.prisma.lessonReport.update({
      where: { lessonId },
      data: dto,
    });
  }
}
