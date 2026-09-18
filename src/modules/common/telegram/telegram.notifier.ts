import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  PayoutStatus,
  RescheduleRequestStatus,
  RescheduleRequestType,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  clip,
  esc,
  formatDate,
  formatDateTime,
  fullName,
  money,
} from './telegram.format';
import { TelegramService } from './telegram.service';

const lessonContext = {
  student: { include: { user: true, telegramGroup: true } },
  teacher: { include: { user: true } },
  enrollment: { include: { course: true } },
} as const;

type LessonHeader = {
  scheduledAt: Date;
  student: { user: { firstName: string; lastName: string } };
  enrollment: { course: { name: string } };
};

// Шаблоны уведомлений. Все методы fire-and-forget, как AuditService.log:
// сбой Telegram не должен ронять бизнес-операцию
@Injectable()
export class TelegramNotifier {
  private readonly logger = new Logger(TelegramNotifier.name);
  private readonly appUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('APP_URL') || undefined;
  }

  reportSaved(reportId: string) {
    this.fire('reportSaved', async () => {
      const report = await this.prisma.lessonReport.findUniqueOrThrow({
        where: { id: reportId },
        include: { lesson: { include: lessonContext } },
      });
      const { lesson } = report;
      const chatId = this.groupChat(lesson.student);
      if (!chatId) return;

      const fields: [string, string | null][] = [
        ['Тема', report.topic],
        ['Что изучили', report.covered],
        ['Результаты', report.results],
        ['Домашнее задание', report.homework],
        ['Рекомендации', report.recommendations],
        ['Комментарий для родителя', report.parentComment],
        ['Дополнительно', report.extraNotes],
      ];
      const edited = report.updatedAt.getTime() !== report.createdAt.getTime();
      const text = [
        '📝 <b>Отчёт по занятию</b>',
        this.header(lesson),
        `👩‍🏫 ${fullName(lesson.teacher.user)}`,
        '',
        ...fields
          .filter(([, value]) => value)
          .map(([label, value]) => `<b>${label}:</b> ${clip(value!, 500)}`),
        ...(edited
          ? ['', `✏️ <i>Изменён ${formatDateTime(report.updatedAt)}</i>`]
          : []),
        this.lessonLink(lesson.id),
      ].join('\n');

      // Правка отчёта редактирует уже отправленное сообщение
      const updated = await this.telegram.updateMessage(
        NotificationType.LESSON_REPORT,
        reportId,
        { text },
      );
      if (!updated) {
        await this.telegram.enqueue({
          chatId,
          type: NotificationType.LESSON_REPORT,
          entityId: reportId,
          text,
        });
      }
    });
  }

  materialAdded(materialId: string) {
    this.fire('materialAdded', async () => {
      const material = await this.prisma.material.findUniqueOrThrow({
        where: { id: materialId },
        include: { lesson: { include: lessonContext } },
      });
      const { lesson } = material;
      if (!lesson) return;
      const chatId = this.groupChat(lesson.student);
      if (!chatId) return;

      await this.telegram.enqueue({
        chatId,
        type: NotificationType.MATERIAL_ADDED,
        entityId: materialId,
        text: [
          '📎 <b>Новый материал к занятию</b>',
          this.header(lesson),
          '',
          `<b>${esc(material.title)}</b>`,
          esc(material.fileUrl),
        ].join('\n'),
      });
    });
  }

  lessonCanceled(lessonId: string) {
    this.fire('lessonCanceled', async () => {
      const lesson = await this.prisma.lesson.findUniqueOrThrow({
        where: { id: lessonId },
        include: lessonContext,
      });
      const chatId = this.groupChat(lesson.student);
      if (!chatId) return;

      await this.telegram.enqueue({
        chatId,
        type: NotificationType.LESSON_CANCEL,
        entityId: lessonId,
        text: ['❌ <b>Занятие отменено</b>', this.header(lesson)].join('\n'),
      });
    });
  }

  // Перенос создаёт новое занятие (rescheduledTo), правка времени — меняет текущее
  lessonRescheduled(lessonId: string, from: Date) {
    this.fire('lessonRescheduled', async () => {
      const lesson = await this.prisma.lesson.findUniqueOrThrow({
        where: { id: lessonId },
        include: { ...lessonContext, rescheduledTo: true },
      });
      const chatId = this.groupChat(lesson.student);
      if (!chatId) return;

      const target = lesson.rescheduledTo ?? lesson;
      await this.telegram.enqueue({
        chatId,
        type: NotificationType.LESSON_RESCHEDULE,
        entityId: lessonId,
        text: [
          '🔄 <b>Занятие перенесено</b>',
          `📚 ${esc(lesson.enrollment.course.name)} · ${fullName(lesson.student.user)}`,
          `🗓 <s>${formatDateTime(from)}</s> → <b>${formatDateTime(target.scheduledAt)}</b> (МСК)`,
          this.lessonLink(target.id),
        ].join('\n'),
      });
    });
  }

  // Создание и решение заявки — одно сообщение: при решении оно редактируется
  // и теряет кнопки
  rescheduleRequestChanged(requestId: string) {
    this.fire('rescheduleRequestChanged', async () => {
      const request = await this.prisma.rescheduleRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          lesson: { include: lessonContext },
          createdBy: true,
          resolvedBy: true,
        },
      });
      const { lesson } = request;
      const chatId = this.groupChat(lesson.student);
      if (!chatId) return;

      const isCancel = request.type === RescheduleRequestType.CANCEL;
      const fromTeacher = request.createdById === lesson.teacherId;
      const pending = request.status === RescheduleRequestStatus.PENDING;
      const status = {
        [RescheduleRequestStatus.PENDING]: `⏳ Ждёт подтверждения: ${fromTeacher ? 'родитель' : 'преподаватель'} или менеджер`,
        [RescheduleRequestStatus.APPROVED]: `✅ Подтверждено: ${request.resolvedBy ? fullName(request.resolvedBy) : '—'}`,
        [RescheduleRequestStatus.REJECTED]: `🚫 Отклонено: ${request.resolvedBy ? fullName(request.resolvedBy) : '—'}`,
      }[request.status];

      const text = [
        isCancel
          ? '❌ <b>Заявка на отмену занятия</b>'
          : '🔄 <b>Заявка на перенос занятия</b>',
        this.header(lesson),
        ...(request.proposedDate
          ? [
              `➡️ Новая дата: <b>${formatDateTime(request.proposedDate)}</b> (МСК)`,
            ]
          : []),
        `👤 ${fullName(request.createdBy)} (${fromTeacher ? 'преподаватель' : 'родитель'})`,
        ...(request.reason ? [`💬 ${clip(request.reason, 500)}`] : []),
        '',
        status,
      ].join('\n');
      const replyMarkup = pending
        ? {
            inline_keyboard: [
              [
                {
                  text: '✅ Подтвердить',
                  callback_data: `rr:approve:${request.id}`,
                },
                {
                  text: '🚫 Отклонить',
                  callback_data: `rr:reject:${request.id}`,
                },
              ],
            ],
          }
        : // Пустая клавиатура снимает кнопки при редактировании
          { inline_keyboard: [] };

      const updated = await this.telegram.updateMessage(
        NotificationType.RESCHEDULE_REQUEST,
        requestId,
        { text, replyMarkup },
      );
      if (!updated && pending) {
        await this.telegram.enqueue({
          chatId,
          type: NotificationType.RESCHEDULE_REQUEST,
          entityId: requestId,
          text,
          replyMarkup,
        });
      }
    });
  }

  // Выплаты — только в личку преподу, не в группу ученика
  payoutChanged(payoutId: string) {
    this.fire('payoutChanged', async () => {
      const payout = await this.prisma.payout.findUniqueOrThrow({
        where: { id: payoutId },
        include: { teacher: { include: { user: true } } },
      });
      const chatId = payout.teacher.user.telegramChatId;
      if (!chatId) return;

      // periodEnd не включается в период [start, end)
      const periodEnd = new Date(payout.periodEnd.getTime() - 1);
      await this.telegram.enqueue({
        chatId,
        type: NotificationType.PAYOUT_NOTIFICATION,
        entityId: payoutId,
        text: [
          payout.status === PayoutStatus.PAID
            ? '✅ <b>Выплата произведена</b>'
            : '💰 <b>Начислена выплата</b>',
          `Период: ${formatDate(payout.periodStart)} — ${formatDate(periodEnd)}`,
          `Занятия: ${money(payout.basePay)}`,
          `Премии за отчёты: ${money(payout.bonusPay)}`,
          `<b>Итого: ${money(payout.totalPay)}</b>`,
        ].join('\n'),
      });
    });
  }

  private fire(name: string, job: () => Promise<void>) {
    if (!this.telegram.enabled) return;
    void job().catch((e) =>
      this.logger.error(`Telegram notification ${name} failed`, e),
    );
  }

  private groupChat(student: {
    telegramGroup: { telegramChatId: string; isActive: boolean } | null;
  }) {
    const group = student.telegramGroup;
    return group?.isActive ? group.telegramChatId : null;
  }

  private header(lesson: LessonHeader) {
    return [
      `📚 ${esc(lesson.enrollment.course.name)} · ${fullName(lesson.student.user)}`,
      `🗓 ${formatDateTime(lesson.scheduledAt)} (МСК)`,
    ].join('\n');
  }

  private lessonLink(lessonId: string) {
    return this.appUrl
      ? `\n<a href="${esc(`${this.appUrl}/lessons/${lessonId}`)}">Открыть в личном кабинете</a>`
      : '';
  }
}
