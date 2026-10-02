import {
  BadRequestException,
  ConflictException,
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
  Role,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
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
  student: {
    select: {
      userId: true,
      user: { omit: { password: true } },
    },
  },
  enrollment: { select: { id: true, courseId: true, course: true } },
  report: true,
  materials: {
    select: {
      id: true,
      lessonId: true,
      title: true,
      fileType: true,
      fileSize: true,
      uploadedAt: true,
    },
  },
} as const;

@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: TelegramNotifier,
  ) {}

  async create(dto: CreateLessonDto) {
    return this.prisma.$transaction(async (tx) => {
      const enrollment = await this.activeEnrollmentForCreation(
        tx,
        dto.enrollmentId,
        dto.teacherId,
        dto.studentId,
      );
      const lesson = await tx.lesson.create({
        data: {
          enrollmentId: enrollment.id,
          teacherId: enrollment.teacherId,
          studentId: enrollment.studentId,
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
      await this.audit.record(
        {
          action: 'lesson.created',
          entityType: 'Lesson',
          entityId: lesson.id,
          details: {
            scheduledAt: dto.scheduledAt,
            teacherId: enrollment.teacherId,
            studentId: enrollment.studentId,
          },
        },
        tx,
      );
      return lesson;
    });
  }

  async generate(dto: GenerateLessonsDto) {
    const dateFrom = new Date(dto.dateFrom);
    const dateTo = new Date(dto.dateTo);
    if (dateTo < dateFrom) {
      throw new BadRequestException('dateTo must be on or after dateFrom');
    }

    return this.prisma.$transaction(async (tx) => {
      const templates = await tx.scheduleTemplate.findMany({
        where: {
          isActive: true,
          enrollment: { is: { isActive: true } },
          ...(dto.templateIds?.length && { id: { in: dto.templateIds } }),
        },
        include: {
          enrollment: true,
          slots: { where: { isActive: true } },
        },
      });

      const enrollmentIds = [...new Set(templates.map((t) => t.enrollmentId))]
        .sort()
        .map((id) => Prisma.sql`${id}`);
      const activeEnrollments = enrollmentIds.length
        ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "enrollments"
            WHERE "id" IN (${Prisma.join(enrollmentIds)}) AND "isActive" = true
            ORDER BY "id" FOR SHARE
          `)
        : [];
      const activeEnrollmentIds = new Set(activeEnrollments.map((e) => e.id));

      const lessonsToCreate: Prisma.LessonCreateManyInput[] = [];
      const plannedKeys = new Set<string>();

      for (const template of templates) {
        if (!activeEnrollmentIds.has(template.enrollmentId)) continue;
        // startTime слотов задан в зоне шаблона — считаем дни и время в ней
        const rangeStart = DateTime.fromJSDate(dateFrom, {
          zone: template.timezone,
        }).startOf('day');
        const rangeEnd = DateTime.fromJSDate(dateTo, {
          zone: template.timezone,
        });

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
      const existing = await tx.lesson.findMany({
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

      const result = await tx.lesson.createMany({
        data: filtered,
        skipDuplicates: true,
      });
      if (result.count) {
        await this.audit.record(
          {
            action: 'lesson.generated',
            entityType: 'Lesson',
            details: {
              count: result.count,
              dateFrom: dto.dateFrom,
              dateTo: dto.dateTo,
            },
          },
          tx,
        );
      }
      return { count: result.count };
    });
  }

  async findAll(
    filters: {
      dateFrom?: string;
      dateTo?: string;
      status?: LessonStatus;
      teacherId?: string;
      studentId?: string;
    },
    scope?: {
      teacherUserId?: string;
      studentUserId?: string;
      hideInternalNotes?: boolean;
    },
  ) {
    const where: Prisma.LessonWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.teacherId) where.teacherId = filters.teacherId;
    if (filters.studentId) where.studentId = filters.studentId;
    if (filters.dateFrom || filters.dateTo) {
      where.scheduledAt = {
        ...(filters.dateFrom && { gte: new Date(filters.dateFrom) }),
        ...(filters.dateTo && { lte: new Date(filters.dateTo) }),
      };
    }

    // Role-based scope
    if (scope?.teacherUserId) {
      where.teacherId = scope.teacherUserId;
    } else if (scope?.studentUserId) {
      where.studentId = scope.studentUserId;
    }

    const lessons = await this.prisma.lesson.findMany({
      where,
      include: lessonInclude,
      orderBy: { scheduledAt: 'asc' },
    });
    return scope?.hideInternalNotes
      ? lessons.map((lesson) => this.withoutInternalNotes(lesson))
      : lessons;
  }

  async findById(
    id: string,
    scope?: {
      teacherUserId?: string;
      studentUserId?: string;
      hideInternalNotes?: boolean;
    },
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id },
      include: lessonInclude,
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (scope?.teacherUserId && lesson.teacherId !== scope.teacherUserId) {
      throw new ForbiddenException('You do not have access to this lesson');
    }
    if (scope?.studentUserId && scope.studentUserId !== lesson.studentId) {
      throw new ForbiddenException('You do not have access to this lesson');
    }

    return scope?.hideInternalNotes
      ? this.withoutInternalNotes(lesson)
      : lesson;
  }

  private withoutInternalNotes<
    T extends { report: { extraNotes: string | null } | null },
  >(lesson: T): T {
    if (!lesson.report) return lesson;
    return {
      ...lesson,
      report: { ...lesson.report, extraNotes: null },
    };
  }

  async complete(id: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const initial = await tx.lesson.findUnique({
          where: { id },
          select: { teacherId: true, studentId: true },
        });
        if (!initial) throw new NotFoundException('Lesson not found');

        const teacherLocks = await tx.$queryRaw<Array<{ userId: string }>>(
          Prisma.sql`SELECT "userId" FROM "teacher_profiles" WHERE "userId" = ${initial.teacherId} FOR UPDATE`,
        );
        if (!teacherLocks.length) {
          throw new NotFoundException('Teacher profile not found');
        }
        const studentLocks = await tx.$queryRaw<Array<{ userId: string }>>(
          Prisma.sql`SELECT "userId" FROM "student_profiles" WHERE "userId" = ${initial.studentId} FOR UPDATE`,
        );
        if (!studentLocks.length) {
          throw new NotFoundException('Student profile not found');
        }

        const lesson = await tx.lesson.findUnique({
          where: { id },
          include: {
            enrollment: {
              select: { lessonPrice: true, teacherRate: true },
            },
          },
        });
        if (!lesson) throw new NotFoundException('Lesson not found');
        if (
          lesson.teacherId !== initial.teacherId ||
          lesson.studentId !== initial.studentId
        ) {
          throw new ConflictException('Lesson participants changed');
        }
        if (lesson.status !== LessonStatus.SCHEDULED) {
          throw new BadRequestException(
            `Cannot complete lesson with status ${lesson.status}`,
          );
        }

        const price = lesson.price ?? lesson.enrollment.lessonPrice;
        const teacherRate = lesson.teacherRate ?? lesson.enrollment.teacherRate;
        const completedAt = new Date();
        const transition = await tx.lesson.updateMany({
          where: { id, status: LessonStatus.SCHEDULED },
          data: {
            status: LessonStatus.COMPLETED,
            completedAt,
            price,
            teacherRate,
          },
        });
        if (!transition.count) {
          await this.throwLessonStateError(tx, id, 'complete');
        }

        if (!price.isZero()) {
          const student = await tx.studentProfile.findUniqueOrThrow({
            where: { userId: lesson.studentId },
          });
          const balanceBefore = student.balance;
          const balanceAfter = balanceBefore.sub(price);
          await tx.studentProfile.update({
            where: { userId: student.userId },
            data: { balance: balanceAfter },
          });
          await tx.transaction.create({
            data: {
              studentId: student.userId,
              lessonId: id,
              type: TransactionType.LESSON_CHARGE,
              amount: price.negated(),
              balanceBefore,
              balanceAfter,
            },
          });
        }

        const completed = await tx.lesson.findUniqueOrThrow({
          where: { id },
          include: lessonInclude,
        });
        await this.audit.record(
          {
            action: 'lesson.completed',
            entityType: 'Lesson',
            entityId: id,
            details: {
              price: price.toString(),
              teacherRate: teacherRate.toString(),
            },
          },
          tx,
        );
        return completed;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Lesson has already been charged');
      }
      throw error;
    }
  }

  async cancel(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const lesson = await this.cancelWithin(tx, id);
      await this.audit.record(
        { action: 'lesson.canceled', entityType: 'Lesson', entityId: id },
        tx,
      );
      await this.notifier.lessonCanceled(id, tx);
      return lesson;
    });
  }

  // Вариант для вызова внутри внешней транзакции (см. RescheduleService.approve)
  /** Отменяет урок внутри внешней транзакции (см. RescheduleService.approve). */
  async cancelWithin(tx: Prisma.TransactionClient, id: string) {
    const transition = await tx.lesson.updateMany({
      where: { id, status: LessonStatus.SCHEDULED },
      data: { status: LessonStatus.CANCELED },
    });
    if (!transition.count) {
      await this.throwLessonStateError(tx, id, 'cancel');
    }

    return tx.lesson.findUniqueOrThrow({
      where: { id },
      include: lessonInclude,
    });
  }

  async reschedule(id: string, dto: RescheduleLessonDto) {
    return this.prisma.$transaction(async (tx) => {
      const lesson = await this.rescheduleWithin(tx, id, dto);
      await this.audit.record(
        {
          action: 'lesson.rescheduled',
          entityType: 'Lesson',
          entityId: id,
          details: {
            newDate: dto.newDate,
            newLessonId: lesson.rescheduledToId,
          },
        },
        tx,
      );
      await this.notifier.lessonRescheduled(id, lesson.scheduledAt, tx);
      return lesson;
    });
  }

  async rescheduleWithin(
    tx: Prisma.TransactionClient,
    id: string,
    dto: RescheduleLessonDto,
  ) {
    await this.lockScheduledLesson(tx, id, 'reschedule');
    const lesson = await tx.lesson.findUnique({ where: { id } });
    if (!lesson) throw new NotFoundException('Lesson not found');

    // Create new lesson at the proposed date
    const newLesson = await tx.lesson.create({
      data: {
        templateId: lesson.templateId,
        enrollmentId: lesson.enrollmentId,
        teacherId: lesson.teacherId,
        studentId: lesson.studentId,
        scheduledAt: new Date(dto.newDate),
        durationMinutes: lesson.durationMinutes,
        price: lesson.price,
        teacherRate: lesson.teacherRate,
      },
    });

    // Mark original as rescheduled
    const transition = await tx.lesson.updateMany({
      where: { id, status: LessonStatus.SCHEDULED },
      data: {
        status: LessonStatus.RESCHEDULED,
        rescheduledToId: newLesson.id,
      },
    });
    if (!transition.count) {
      await this.throwLessonStateError(tx, id, 'reschedule');
    }
    return tx.lesson.findUniqueOrThrow({
      where: { id },
      include: { ...lessonInclude, rescheduledTo: true },
    });
  }

  async update(id: string, dto: UpdateLessonDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockScheduledLesson(tx, id, 'update');
      const before = await tx.lesson.findUniqueOrThrow({ where: { id } });
      const data = {
        ...(dto.scheduledAt !== undefined && {
          scheduledAt: new Date(dto.scheduledAt),
        }),
        ...(dto.durationMinutes !== undefined && {
          durationMinutes: dto.durationMinutes,
        }),
        ...(dto.price !== undefined && {
          price: new Prisma.Decimal(dto.price),
        }),
        ...(dto.teacherRate !== undefined && {
          teacherRate: new Prisma.Decimal(dto.teacherRate),
        }),
      };
      const transition = await tx.lesson.updateMany({
        where: { id, status: LessonStatus.SCHEDULED },
        data,
      });
      if (!transition.count) {
        await this.throwLessonStateError(tx, id, 'update');
      }
      const updated = await tx.lesson.findUniqueOrThrow({
        where: { id },
        include: lessonInclude,
      });
      await this.audit.record(
        {
          action: 'lesson.updated',
          entityType: 'Lesson',
          entityId: id,
          details: dto,
        },
        tx,
      );
      if (updated.scheduledAt.getTime() !== before.scheduledAt.getTime()) {
        await this.notifier.lessonRescheduled(id, before.scheduledAt, tx);
      }
      return updated;
    });
  }

  async remove(id: string) {
    await this.prisma.$transaction(async (tx) => {
      // Delete request rows before locking the lesson to keep request → lesson order.
      await tx.rescheduleRequest.deleteMany({ where: { lessonId: id } });
      const transition = await tx.lesson.updateMany({
        where: {
          id,
          status: {
            in: [
              LessonStatus.SCHEDULED,
              LessonStatus.CANCELED,
              LessonStatus.RESCHEDULED,
            ],
          },
        },
        data: { updatedAt: new Date() },
      });
      if (!transition.count) {
        await this.throwLessonStateError(tx, id, 'delete');
      }
      await tx.material.deleteMany({ where: { lessonId: id } });
      // Занятие могло быть создано переносом другого — снимаем ссылку на него
      // снимаем ссылку rescheduledToId, если урок создан переносом
      await tx.lesson.updateMany({
        where: { rescheduledToId: id },
        data: { rescheduledToId: null },
      });
      await tx.lesson.delete({ where: { id } });
      await this.audit.record(
        { action: 'lesson.deleted', entityType: 'Lesson', entityId: id },
        tx,
      );
    });
  }

  private async activeEnrollmentForCreation(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
    suppliedTeacherId?: string,
    suppliedStudentId?: string,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "enrollments"
      WHERE "id" = ${enrollmentId} AND "isActive" = true
      FOR SHARE
    `);
    if (!rows.length) {
      throw new BadRequestException(
        'enrollmentId must reference an active enrollment',
      );
    }
    const enrollment = await tx.enrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
      select: { id: true, teacherId: true, studentId: true },
    });
    if (
      (suppliedTeacherId !== undefined &&
        suppliedTeacherId !== enrollment.teacherId) ||
      (suppliedStudentId !== undefined &&
        suppliedStudentId !== enrollment.studentId)
    ) {
      throw new BadRequestException(
        'teacherId and studentId must match the enrollment',
      );
    }
    return enrollment;
  }

  private async lockScheduledLesson(
    tx: Prisma.TransactionClient,
    id: string,
    operation: 'update' | 'reschedule',
  ) {
    const transition = await tx.lesson.updateMany({
      where: { id, status: LessonStatus.SCHEDULED },
      data: { updatedAt: new Date() },
    });
    if (!transition.count) await this.throwLessonStateError(tx, id, operation);
  }

  private async throwLessonStateError(
    tx: Prisma.TransactionClient,
    id: string,
    operation: 'complete' | 'cancel' | 'reschedule' | 'update' | 'delete',
  ): Promise<never> {
    const lesson = await tx.lesson.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (operation === 'delete' && lesson.status === LessonStatus.COMPLETED) {
      throw new BadRequestException(
        'Cannot delete a completed lesson: it has financial history',
      );
    }
    throw new BadRequestException(
      `Cannot ${operation} lesson with status ${lesson.status}`,
    );
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

  async assertUserCanView(
    lessonId: string,
    user: { id: string; roles: Role[] },
  ) {
    if (user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER)) {
      return;
    }
    if (user.roles.includes(Role.TEACHER)) {
      return this.assertTeacherOwns(lessonId, user.id);
    }

    if (user.roles.includes(Role.STUDENT)) {
      const lesson = await this.prisma.lesson.findFirst({
        where: { id: lessonId, studentId: user.id },
        select: { id: true },
      });
      if (lesson) return;
    }
    throw new ForbiddenException('You do not have access to this lesson');
  }
}
