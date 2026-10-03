import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  LessonStatus,
  Role,
  RescheduleRequestStatus,
  RescheduleRequestType,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { TelegramService } from '../../common/telegram/telegram.service';
import { UsersService } from '../users/users.service';
import { LessonsService } from './lessons.service';
import { CreateRescheduleRequestDto } from './dto/create-reschedule-request.dto';
import { paginated, paginationArgs } from '../../common/pagination';

type Actor = { id: string; roles: Role[] };

@Injectable()
export class RescheduleService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lessonsService: LessonsService,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
    private readonly notifier: TelegramNotifier,
  ) {}

  // Кнопки «Подтвердить / Отклонить» под заявкой в группе ученика
  /** Регистрирует callback-кнопки «Подтвердить / Отклонить» под заявкой в группе ученика. */
  onModuleInit() {
    this.telegram.bot?.callbackQuery(
      /^rr:(approve|reject):(\w+)$/,
      async (ctx) => {
        const [, action, requestId] = ctx.match;
        const actor = await this.findTelegramActor(ctx.from.id, requestId);
        if (!actor) {
          await ctx.answerCallbackQuery({
            text: 'Эта заявка доступна только её участникам и сотрудникам.',
            show_alert: true,
          });
          return;
        }
        try {
          if (action === 'approve') await this.approve(requestId, actor);
          else await this.reject(requestId, actor);
          await ctx.answerCallbackQuery({
            text:
              action === 'approve' ? 'Заявка подтверждена' : 'Заявка отклонена',
          });
        } catch (e) {
          if (!(e instanceof HttpException)) throw e;
          await ctx.answerCallbackQuery({
            text:
              e instanceof ForbiddenException
                ? 'Решение принимает другая сторона или менеджер.'
                : 'Заявка уже рассмотрена или занятие изменено.',
            show_alert: true,
          });
        }
      },
    );
  }

  async createRequest(
    lessonId: string,
    user: Actor,
    dto: CreateRescheduleRequestDto,
  ) {
    if (dto.type === RescheduleRequestType.RESCHEDULE && !dto.proposedDate) {
      throw new BadRequestException(
        'proposedDate is required for RESCHEDULE type',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({
        where: { id: lessonId },
        select: { status: true, teacherId: true, studentId: true },
      });
      if (!lesson) throw new NotFoundException('Lesson not found');
      this.assertOwnsLesson(user, lesson.teacherId, lesson.studentId);
      if (lesson.status !== LessonStatus.SCHEDULED) {
        throw new BadRequestException(
          `Cannot create a request for lesson with status ${lesson.status}`,
        );
      }
      const locked = await tx.lesson.updateMany({
        where: { id: lessonId, status: LessonStatus.SCHEDULED },
        data: { updatedAt: new Date() },
      });
      if (!locked.count) {
        const current = await tx.lesson.findUnique({
          where: { id: lessonId },
          select: { status: true },
        });
        if (!current) throw new NotFoundException('Lesson not found');
        throw new BadRequestException(
          `Cannot create a request for lesson with status ${current.status}`,
        );
      }

      const request = await tx.rescheduleRequest.create({
        data: {
          lessonId,
          createdById: user.id,
          type: dto.type,
          reason: dto.reason,
          proposedDate: dto.proposedDate
            ? new Date(dto.proposedDate)
            : undefined,
        },
        include: { lesson: true, createdBy: { omit: { password: true } } },
      });
      await this.audit.record(
        {
          action: 'reschedule_request.created',
          entityType: 'RescheduleRequest',
          entityId: request.id,
          details: { lessonId, type: dto.type, proposedDate: dto.proposedDate },
        },
        tx,
      );
      await this.notifier.rescheduleRequestChanged(request.id, tx);
      return request;
    });
  }

  /** Checks that a teacher or student belongs to the requested lesson. */
  private assertOwnsLesson(user: Actor, teacherId: string, studentId: string) {
    if (user.roles.includes(Role.TEACHER) && user.id === teacherId) {
      return;
    }
    if (user.roles.includes(Role.STUDENT) && user.id === studentId) return;
    throw new ForbiddenException('You do not have access to this lesson');
  }

  findAll(
    filters: {
      status?: RescheduleRequestStatus;
      lessonId?: string;
      page: number;
      limit: number;
    },
    actor: Actor,
  ) {
    const isStaff =
      actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.MANAGER);
    const lessonScope = isStaff
      ? undefined
      : actor.roles.includes(Role.TEACHER)
        ? { teacherId: actor.id }
        : actor.roles.includes(Role.STUDENT)
          ? { studentId: actor.id }
          : null;
    if (lessonScope === null) throw new ForbiddenException();
    const where: Prisma.RescheduleRequestWhereInput = {
      status: filters.status,
      lessonId: filters.lessonId,
      ...(lessonScope && { lesson: { is: lessonScope } }),
    };
    const include = {
      lesson: true,
      createdBy: { omit: { password: true } },
      resolvedBy: { omit: { password: true } },
    };
    return Promise.all([
      this.prisma.rescheduleRequest.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...paginationArgs(filters),
      }),
      this.prisma.rescheduleRequest.count({ where }),
    ]).then(([data, total]) =>
      paginated(data, total, filters, '/api/reschedule-requests', {
        status: filters.status,
        lessonId: filters.lessonId,
      }),
    );
  }

  async approve(requestId: string, actor: Actor) {
    const request = await this.findForResolve(requestId, actor);

    // Изменение урока + закрытие заявки атомарно
    return this.prisma.$transaction(async (tx) => {
      await this.closePending(
        tx,
        requestId,
        actor.id,
        RescheduleRequestStatus.APPROVED,
      );
      if (request.type === RescheduleRequestType.CANCEL) {
        await this.lessonsService.cancelWithin(tx, request.lessonId);
        await this.audit.record(
          {
            action: 'lesson.canceled',
            entityType: 'Lesson',
            entityId: request.lessonId,
            actorId: actor.id,
          },
          tx,
        );
        await this.notifier.lessonCanceled(request.lessonId, tx);
      } else {
        const lesson = await this.lessonsService.rescheduleWithin(
          tx,
          request.lessonId,
          {
            newDate: request.proposedDate!.toISOString(),
          },
        );
        await this.audit.record(
          {
            action: 'lesson.rescheduled',
            entityType: 'Lesson',
            entityId: request.lessonId,
            actorId: actor.id,
            details: {
              newDate: request.proposedDate!.toISOString(),
              newLessonId: lesson.rescheduledToId,
            },
          },
          tx,
        );
        await this.notifier.lessonRescheduled(
          request.lessonId,
          request.lesson.scheduledAt,
          tx,
        );
      }
      await this.audit.record(
        {
          action: 'reschedule_request.approved',
          entityType: 'RescheduleRequest',
          entityId: requestId,
          actorId: actor.id,
          details: {
            lessonId: request.lessonId,
            type: request.type,
            proposedDate: request.proposedDate?.toISOString(),
          },
        },
        tx,
      );
      await this.notifier.rescheduleRequestChanged(requestId, tx);
      return tx.rescheduleRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { lesson: true },
      });
    });
  }

  async reject(requestId: string, actor: Actor) {
    const request = await this.findForResolve(requestId, actor);

    return this.prisma.$transaction(async (tx) => {
      await this.closePending(
        tx,
        requestId,
        actor.id,
        RescheduleRequestStatus.REJECTED,
      );
      await this.audit.record(
        {
          action: 'reschedule_request.rejected',
          entityType: 'RescheduleRequest',
          entityId: requestId,
          actorId: actor.id,
          details: { lessonId: request.lessonId },
        },
        tx,
      );
      await this.notifier.rescheduleRequestChanged(requestId, tx);
      return tx.rescheduleRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { lesson: true },
      });
    });
  }

  private async findForResolve(id: string, actor: Actor) {
    const request = await this.prisma.rescheduleRequest.findUnique({
      where: { id },
      include: {
        lesson: { include: { student: { select: { userId: true } } } },
      },
    });
    if (!request) {
      throw new NotFoundException('Reschedule request not found');
    }
    if (request.status !== RescheduleRequestStatus.PENDING) {
      throw new BadRequestException('Request is already resolved');
    }
    this.assertCanResolve(request, actor);
    return request;
  }

  /** Lets the other lesson participant or staff resolve a request. */
  private assertCanResolve(
    request: {
      createdById: string;
      lesson: { teacherId: string; student: { userId: string } };
    },
    actor: Actor,
  ) {
    if (
      actor.roles.includes(Role.ADMIN) ||
      actor.roles.includes(Role.MANAGER)
    ) {
      return;
    }
    const { teacherId, student } = request.lesson;
    const otherSide =
      request.createdById === teacherId ? student.userId : teacherId;
    if (actor.id !== otherSide || actor.id === request.createdById) {
      throw new ForbiddenException(
        'Only the other side or staff can resolve this request',
      );
    }
  }

  // Условный апдейт закрывает гонку двойного подтверждения (двойной клик по кнопке):
  // второй запрос уже не найдёт PENDING и не перенесёт урок повторно
  /**
   * updateMany по PENDING закрывает гонку двойного подтверждения:
   * второй запрос не найдёт PENDING и не сделает повторный перенос.
   */
  private async closePending(
    tx: Prisma.TransactionClient,
    id: string,
    resolvedById: string,
    status: RescheduleRequestStatus,
  ) {
    const { count } = await tx.rescheduleRequest.updateMany({
      where: { id, status: RescheduleRequestStatus.PENDING },
      data: { status, resolvedById, resolvedAt: new Date() },
    });
    if (!count) throw new BadRequestException('Request is already resolved');
  }

  // В личном чате chat.id совпадает с Telegram user id — по нему опознаём
  // нажавшего кнопку в группе
  /** Finds a linked active user who is authorized for this specific request. */
  private async findTelegramActor(telegramUserId: number, requestId: string) {
    const request = await this.prisma.rescheduleRequest.findUnique({
      where: { id: requestId },
      select: {
        createdById: true,
        lesson: { select: { teacherId: true, studentId: true } },
      },
    });
    if (!request) return null;

    const users = await this.prisma.user.findMany({
      where: { telegramChatId: String(telegramUserId), isActive: true },
      include: UsersService.profileExists,
    });
    const linkedUsers = users.map((user) => ({
      id: user.id,
      roles: UsersService.resolveRoles(user),
    }));
    const staff = linkedUsers.find(
      (user) =>
        user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER),
    );
    if (staff) return staff;

    // A participant cannot approve their own request through another profile
    // that happens to share the same Telegram account.
    if (
      linkedUsers.some(
        (user) =>
          user.id === request.createdById &&
          (user.roles.includes(Role.TEACHER) ||
            user.roles.includes(Role.STUDENT)),
      )
    ) {
      return null;
    }

    const otherSideIsStudent = request.createdById === request.lesson.teacherId;
    const otherSideId = otherSideIsStudent
      ? request.lesson.studentId
      : request.lesson.teacherId;
    const otherSideRole = otherSideIsStudent ? Role.STUDENT : Role.TEACHER;
    return (
      linkedUsers.find(
        (user) => user.id === otherSideId && user.roles.includes(otherSideRole),
      ) ?? null
    );
  }
}
