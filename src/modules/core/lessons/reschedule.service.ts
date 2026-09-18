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
  onModuleInit() {
    this.telegram.bot?.callbackQuery(
      /^rr:(approve|reject):(\w+)$/,
      async (ctx) => {
        const [, action, requestId] = ctx.match;
        const actor = await this.findTelegramActor(ctx.from.id);
        if (!actor) {
          await ctx.answerCallbackQuery({
            text: 'Сначала подключите Telegram: в профиле личного кабинета или по ссылке от менеджера.',
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

    const lesson = await this.lessonsService.findById(lessonId);
    await this.assertOwnsLesson(user, lesson.teacherId, lesson.studentId);

    const request = await this.prisma.rescheduleRequest.create({
      data: {
        lessonId,
        createdById: user.id,
        type: dto.type,
        reason: dto.reason,
        proposedDate: dto.proposedDate ? new Date(dto.proposedDate) : undefined,
      },
      include: { lesson: true, createdBy: { omit: { password: true } } },
    });
    this.audit.log({
      action: 'reschedule_request.created',
      entityType: 'RescheduleRequest',
      entityId: request.id,
      details: { lessonId, type: dto.type, proposedDate: dto.proposedDate },
    });
    this.notifier.rescheduleRequestChanged(request.id);
    return request;
  }

  // Учитель может заявлять только по своим урокам, родитель — по урокам своих детей
  private async assertOwnsLesson(
    user: Actor,
    teacherId: string,
    studentId: string,
  ) {
    if (user.roles.includes(Role.TEACHER) && user.id === teacherId) {
      return;
    }
    if (user.roles.includes(Role.PARENT)) {
      const parent = await this.prisma.parentProfile.findUnique({
        where: { userId: user.id },
        select: { students: { select: { userId: true } } },
      });
      if (parent?.students.some((s) => s.userId === studentId)) return;
    }
    throw new ForbiddenException('You do not have access to this lesson');
  }

  findAll(filters: { status?: RescheduleRequestStatus; lessonId?: string }) {
    return this.prisma.rescheduleRequest.findMany({
      where: {
        status: filters.status,
        lessonId: filters.lessonId,
      },
      include: {
        lesson: true,
        createdBy: { omit: { password: true } },
        resolvedBy: { omit: { password: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(requestId: string, actor: Actor) {
    const request = await this.findForResolve(requestId, actor);

    // Изменение урока + закрытие заявки атомарно
    const approved = await this.prisma.$transaction(async (tx) => {
      await this.closePending(
        tx,
        requestId,
        actor.id,
        RescheduleRequestStatus.APPROVED,
      );
      if (request.type === RescheduleRequestType.CANCEL) {
        await this.lessonsService.cancelWithin(tx, request.lessonId);
      } else {
        await this.lessonsService.rescheduleWithin(tx, request.lessonId, {
          newDate: request.proposedDate!.toISOString(),
        });
      }
      return tx.rescheduleRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { lesson: true },
      });
    });
    this.audit.log({
      action: 'reschedule_request.approved',
      entityType: 'RescheduleRequest',
      entityId: requestId,
      actorId: actor.id,
      details: {
        lessonId: request.lessonId,
        type: request.type,
        proposedDate: request.proposedDate?.toISOString(),
      },
    });
    this.notifier.rescheduleRequestChanged(requestId);
    if (request.type === RescheduleRequestType.CANCEL) {
      this.notifier.lessonCanceled(request.lessonId);
    } else {
      this.notifier.lessonRescheduled(
        request.lessonId,
        request.lesson.scheduledAt,
      );
    }
    return approved;
  }

  async reject(requestId: string, actor: Actor) {
    const request = await this.findForResolve(requestId, actor);

    await this.closePending(
      this.prisma,
      requestId,
      actor.id,
      RescheduleRequestStatus.REJECTED,
    );
    const rejected = await this.prisma.rescheduleRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { lesson: true },
    });
    this.audit.log({
      action: 'reschedule_request.rejected',
      entityType: 'RescheduleRequest',
      entityId: requestId,
      actorId: actor.id,
      details: { lessonId: request.lessonId },
    });
    this.notifier.rescheduleRequestChanged(requestId);
    return rejected;
  }

  private async findForResolve(id: string, actor: Actor) {
    const request = await this.prisma.rescheduleRequest.findUnique({
      where: { id },
      include: {
        lesson: { include: { student: { select: { parentId: true } } } },
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

  // Заявку преподавателя решает родитель ученика, заявку родителя — преподаватель.
  // ADMIN/MANAGER — любую
  private assertCanResolve(
    request: {
      createdById: string;
      lesson: { teacherId: string; student: { parentId: string | null } };
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
      request.createdById === teacherId ? student.parentId : teacherId;
    if (actor.id !== otherSide || actor.id === request.createdById) {
      throw new ForbiddenException(
        'Only the other side or staff can resolve this request',
      );
    }
  }

  // Условный апдейт закрывает гонку двойного подтверждения (двойной клик по кнопке):
  // второй запрос уже не найдёт PENDING и не перенесёт урок повторно
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
  private async findTelegramActor(telegramUserId: number) {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: String(telegramUserId) },
      include: UsersService.profileExists,
    });
    return user?.isActive
      ? { id: user.id, roles: UsersService.resolveRoles(user) }
      : null;
  }
}
