import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LessonStatus,
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

const MINUTE_MS = 60 * 1000;

// Окна напоминаний: за сутки (23-24ч) и за 15 минут до занятия
const LESSON_REMINDERS = [
  {
    type: NotificationType.LESSON_REMINDER_DAY,
    fromMs: 23 * 60 * MINUTE_MS,
    toMs: 24 * 60 * MINUTE_MS,
    title: '📅 <b>Напоминание о занятии</b>',
  },
  {
    type: NotificationType.LESSON_REMINDER_SOON,
    fromMs: 0,
    toMs: 15 * MINUTE_MS,
    title: '⏰ <b>Занятие скоро начнётся</b>',
  },
];

type LessonHeader = {
  scheduledAt: Date;
  student: { user: { firstName: string; lastName: string } };
  enrollment: { course: { name: string } };
};

/** Отправляет уведомления в Telegram (fire-and-forget). */
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

  /** Отправляет или обновляет отчет по занятию в группе ученика. */
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
        ['Что делали', report.covered],
        ['Итог', report.results],
        ['Домашнее задание', report.homework],
        ['Следующий шаг', report.recommendations],
        ['Комментарий для родителя', report.parentComment],
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

  /** Отправляет уведомление о добавлении материала к занятию в группу ученика. */
  materialAdded(materialId: string) {
    this.fire('materialAdded', async () => {
      const material = await this.prisma.material.findUniqueOrThrow({
        where: { id: materialId },
        select: {
          title: true,
          lesson: { include: lessonContext },
        },
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
          this.lessonLink(lesson.id),
        ].join('\n'),
      });
    });
  }

  /** Отправляет уведомление об отмене занятия в группу ученика. */
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

  /** Отправляет уведомление о переносе занятия в группу ученика. */
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

  /** Создает или обновляет сообщение с заявкой на перенос/отмену в группе ученика. */
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
        : { inline_keyboard: [] };

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

  /** Отправляет напоминания о занятиях за сутки и за 15 минут. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sendLessonReminders() {
    if (!this.telegram.enabled) return;
    const now = Date.now();

    for (const reminder of LESSON_REMINDERS) {
      const lessons = await this.prisma.lesson.findMany({
        where: {
          status: LessonStatus.SCHEDULED,
          scheduledAt: {
            gt: new Date(now + reminder.fromMs),
            lte: new Date(now + reminder.toMs),
          },
          student: { telegramGroup: { isActive: true } },
        },
        include: lessonContext,
      });
      if (!lessons.length) continue;

      const sent = await this.prisma.telegramNotification.findMany({
        where: {
          type: reminder.type,
          entityId: { in: lessons.map((l) => l.id) },
        },
        select: { entityId: true },
      });
      const sentIds = new Set(sent.map((n) => n.entityId));

      for (const lesson of lessons) {
        const chatId = this.groupChat(lesson.student);
        if (!chatId || sentIds.has(lesson.id)) continue;
        await this.telegram.enqueue({
          chatId,
          type: reminder.type,
          entityId: lesson.id,
          text: [
            reminder.title,
            this.header(lesson),
            `👩‍🏫 ${fullName(lesson.teacher.user)}`,
          ].join('\n'),
        });
      }
    }
  }

  /** Отправляет уведомление о расчете или переводе выплаты преподавателю. */
  payoutChanged(payoutId: string) {
    this.fire('payoutChanged', async () => {
      const payout = await this.prisma.payout.findUniqueOrThrow({
        where: { id: payoutId },
        include: { teacher: { include: { user: true } } },
      });
      const chatId = payout.teacher.user.telegramChatId;
      if (!chatId) return;

      // исключаем правую границу диапазона [start, end)
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
