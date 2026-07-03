import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  Prisma,
  LessonStatus,
  DayOfWeek,
  TransactionType,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { GenerateLessonsDto } from './dto/generate-lessons.dto';
import { RescheduleLessonDto } from './dto/reschedule-lesson.dto';

// luxon weekday: 1 = понедельник … 7 = воскресенье
const LUXON_WEEKDAY: Record<DayOfWeek, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

const lessonInclude = {
  teacher: { include: { user: { omit: { password: true } } } },
  student: { include: { user: { omit: { password: true } } } },
  report: true,
  materials: true,
} as const;

@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateLessonDto) {
    const lesson = await this.prisma.lesson.create({
      data: {
        enrollmentId: dto.enrollmentId,
        teacherId: dto.teacherId,
        studentId: dto.studentId,
        scheduledAt: new Date(dto.scheduledAt),
        durationMinutes: dto.durationMinutes,
        price: dto.price != null ? new Prisma.Decimal(dto.price) : undefined,
        teacherRate:
          dto.teacherRate != null
            ? new Prisma.Decimal(dto.teacherRate)
            : undefined,
      },
      include: lessonInclude,
    });
    this.audit.log({
      action: 'lesson.created',
      entityType: 'Lesson',
      entityId: lesson.id,
      details: {
        scheduledAt: dto.scheduledAt,
        teacherId: dto.teacherId,
        studentId: dto.studentId,
      },
    });
    return lesson;
  }

  async generate(dto: GenerateLessonsDto) {
    const dateFrom = new Date(dto.dateFrom);
    const dateTo = new Date(dto.dateTo);
    if (dateTo < dateFrom) {
      throw new BadRequestException('dateTo must be on or after dateFrom');
    }

    const templates = await this.prisma.scheduleTemplate.findMany({
      where: {
        isActive: true,
        ...(dto.templateIds?.length && { id: { in: dto.templateIds } }),
      },
      include: {
        enrollment: true,
        slots: { where: { isActive: true } },
      },
    });

    const lessonsToCreate: Prisma.LessonCreateManyInput[] = [];
    const plannedKeys = new Set<string>();

    for (const template of templates) {
      // startTime слотов задан в зоне шаблона — считаем дни и время в ней
      const rangeStart = DateTime.fromJSDate(dateFrom, {
        zone: template.timezone,
      }).startOf('day');
      const rangeEnd = DateTime.fromJSDate(dateTo, { zone: template.timezone });

      for (const slot of template.slots) {
        const targetWeekday = LUXON_WEEKDAY[slot.dayOfWeek];
        const [hour, minute] = slot.startTime.split(':').map(Number);

        // Все совпадающие даты в диапазоне [dateFrom, dateTo] включительно
        for (
          let day = rangeStart;
          day <= rangeEnd;
          day = day.plus({ days: 1 })
        ) {
          if (day.weekday !== targetWeekday) continue;

          const scheduledAt = day.set({ hour, minute }).toJSDate();

          // Слот мог выйти за границы диапазона после установки времени
          if (scheduledAt < dateFrom || scheduledAt > dateTo) continue;

          const plannedKey = `${template.id}_${scheduledAt.toISOString()}`;
          if (plannedKeys.has(plannedKey)) continue;
          plannedKeys.add(plannedKey);

          lessonsToCreate.push({
            templateId: template.id,
            enrollmentId: template.enrollmentId,
            teacherId: template.teacherId,
            studentId: template.studentId,
            scheduledAt,
            durationMinutes: slot.durationMinutes,
          });
        }
      }
    }

    if (!lessonsToCreate.length) return { count: 0 };

    // Skip duplicates: same template + same scheduledAt
    const existing = await this.prisma.lesson.findMany({
      where: {
        templateId: {
          in: lessonsToCreate.map((l) => l.templateId!).filter(Boolean),
        },
        scheduledAt: { gte: dateFrom, lte: dateTo },
        status: { not: LessonStatus.CANCELED },
      },
      select: { templateId: true, scheduledAt: true },
    });

    const existingKeys = new Set(
      existing.map((e) => `${e.templateId}_${e.scheduledAt.toISOString()}`),
    );

    const filtered = lessonsToCreate.filter(
      (l) =>
        !existingKeys.has(
          `${l.templateId}_${(l.scheduledAt as Date).toISOString()}`,
        ),
    );

    if (!filtered.length) return { count: 0 };

    const result = await this.prisma.lesson.createMany({
      data: filtered,
      skipDuplicates: true,
    });
    if (result.count) {
      this.audit.log({
        action: 'lesson.generated',
        entityType: 'Lesson',
        details: {
          count: result.count,
          dateFrom: dto.dateFrom,
          dateTo: dto.dateTo,
        },
      });
    }
    return { count: result.count };
  }

  async findAll(
    filters: {
      from?: string;
      to?: string;
      status?: LessonStatus;
      teacherId?: string;
      studentId?: string;
    },
    scope?: { teacherUserId?: string; studentUserIds?: string[] },
  ) {
    const where: Prisma.LessonWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.teacherId) where.teacherId = filters.teacherId;
    if (filters.studentId) where.studentId = filters.studentId;
    if (filters.from || filters.to) {
      where.scheduledAt = {
        ...(filters.from && { gte: new Date(filters.from) }),
        ...(filters.to && { lte: new Date(filters.to) }),
      };
    }

    // Role-based scope
    if (scope?.teacherUserId) {
      where.teacherId = scope.teacherUserId;
    } else if (scope?.studentUserIds?.length) {
      where.studentId = { in: scope.studentUserIds };
    }

    return this.prisma.lesson.findMany({
      where,
      include: lessonInclude,
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async findById(
    id: string,
    scope?: { teacherUserId?: string; studentUserIds?: string[] },
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id },
      include: lessonInclude,
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (scope?.teacherUserId && lesson.teacherId !== scope.teacherUserId) {
      throw new ForbiddenException('You do not have access to this lesson');
    }
    if (
      scope?.studentUserIds &&
      !scope.studentUserIds.includes(lesson.studentId)
    ) {
      throw new ForbiddenException('You do not have access to this lesson');
    }

    return lesson;
  }

  async complete(id: string) {
    const lesson = await this.findById(id);

    if (lesson.status !== LessonStatus.SCHEDULED) {
      throw new BadRequestException(
        `Cannot complete lesson with status ${lesson.status}`,
      );
    }

    const enrollment = await this.prisma.enrollment.findUniqueOrThrow({
      where: { id: lesson.enrollmentId },
    });

    const price = lesson.price ?? enrollment.lessonPrice;
    const teacherRate = lesson.teacherRate ?? enrollment.teacherRate;

    // price=0 → trial lesson, skip financial transaction
    if (Number(price) === 0) {
      const updated = await this.prisma.lesson.update({
        where: { id },
        data: {
          status: LessonStatus.COMPLETED,
          completedAt: new Date(),
          price,
          teacherRate,
        },
        include: lessonInclude,
      });
      this.audit.log({
        action: 'lesson.completed',
        entityType: 'Lesson',
        entityId: id,
        details: { price: 0 },
      });
      return updated;
    }

    // Financial transaction in a single DB transaction
    const completed = await this.prisma.$transaction(async (tx) => {
      const student = await tx.studentProfile.findUniqueOrThrow({
        where: { userId: lesson.studentId },
      });

      if (!student.parentId) {
        throw new BadRequestException(
          'Cannot charge a paid lesson: student has no parent assigned',
        );
      }

      const parent = await tx.parentProfile.findUniqueOrThrow({
        where: { userId: student.parentId },
      });

      const balanceBefore = parent.balance;
      const balanceAfter = balanceBefore.sub(price);

      await tx.parentProfile.update({
        where: { userId: parent.userId },
        data: { balance: balanceAfter },
      });

      await tx.transaction.create({
        data: {
          parentId: parent.userId,
          lessonId: id,
          type: TransactionType.LESSON_CHARGE,
          amount: price.negated(),
          balanceBefore,
          balanceAfter,
        },
      });

      return tx.lesson.update({
        where: { id },
        data: {
          status: LessonStatus.COMPLETED,
          completedAt: new Date(),
          price,
          teacherRate,
        },
        include: lessonInclude,
      });
    });
    this.audit.log({
      action: 'lesson.completed',
      entityType: 'Lesson',
      entityId: id,
      details: { price: Number(price), teacherRate: Number(teacherRate) },
    });
    return completed;
  }

  async cancel(id: string) {
    const lesson = await this.cancelWithin(this.prisma, id);
    this.audit.log({
      action: 'lesson.canceled',
      entityType: 'Lesson',
      entityId: id,
    });
    return lesson;
  }

  // Вариант для вызова внутри внешней транзакции (см. RescheduleService.approve)
  async cancelWithin(tx: Prisma.TransactionClient, id: string) {
    const lesson = await tx.lesson.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.status !== LessonStatus.SCHEDULED) {
      throw new BadRequestException(
        `Cannot cancel lesson with status ${lesson.status}`,
      );
    }

    return tx.lesson.update({
      where: { id },
      data: { status: LessonStatus.CANCELED },
      include: lessonInclude,
    });
  }

  async reschedule(id: string, dto: RescheduleLessonDto) {
    const lesson = await this.prisma.$transaction((tx) =>
      this.rescheduleWithin(tx, id, dto),
    );
    this.audit.log({
      action: 'lesson.rescheduled',
      entityType: 'Lesson',
      entityId: id,
      details: { newDate: dto.newDate, newLessonId: lesson.rescheduledToId },
    });
    return lesson;
  }

  async rescheduleWithin(
    tx: Prisma.TransactionClient,
    id: string,
    dto: RescheduleLessonDto,
  ) {
    const lesson = await tx.lesson.findUnique({ where: { id } });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.status !== LessonStatus.SCHEDULED) {
      throw new BadRequestException(
        `Cannot reschedule lesson with status ${lesson.status}`,
      );
    }

    // Create new lesson at the proposed date
    const newLesson = await tx.lesson.create({
      data: {
        templateId: lesson.templateId,
        enrollmentId: lesson.enrollmentId,
        teacherId: lesson.teacherId,
        studentId: lesson.studentId,
        scheduledAt: new Date(dto.newDate),
        durationMinutes: lesson.durationMinutes,
      },
    });

    // Mark original as rescheduled
    return tx.lesson.update({
      where: { id },
      data: {
        status: LessonStatus.RESCHEDULED,
        rescheduledToId: newLesson.id,
      },
      include: { ...lessonInclude, rescheduledTo: true },
    });
  }

  async assertTeacherOwns(lessonId: string, teacherUserId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { teacherId: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.teacherId !== teacherUserId) {
      throw new ForbiddenException('You do not have access to this lesson');
    }
  }
}
