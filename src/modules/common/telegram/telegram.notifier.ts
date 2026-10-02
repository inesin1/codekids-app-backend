import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import {
  LessonStatus,
  NotificationType,
  PayoutStatus,
  Role,
  Prisma,
  RescheduleRequestStatus,
  RescheduleRequestType,
  TelegramRecipientKind,
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

const BIRTHDAY_REMINDERS = [
  {
    type: NotificationType.BIRTHDAY_REMINDER_WEEK,
    daysBefore: 7,
    title: '🎂 <b>День рождения через неделю</b>',
  },
  {
    type: NotificationType.BIRTHDAY_REMINDER_DAY,
    daysBefore: 1,
    title: '🎂 <b>День рождения завтра</b>',
  },
  {
    type: NotificationType.BIRTHDAY_REMINDER_TODAY,
    daysBefore: 0,
    title: '🎉 <b>Сегодня день рождения</b>',
  },
] as const;

const MOSCOW_TIME_ZONE = 'Europe/Moscow';

type LessonHeader = {
  scheduledAt: Date;
  student: { user: { firstName: string; lastName: string } };
  enrollment: { course: { name: string } };
};

/** Сохраняет исходящие уведомления Telegram. */
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

  /** Ставит отчет и его вложения в очередь Telegram. */
  async queueReport(
    reportId: string,
    edited = false,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const report = await db.lessonReport.findUniqueOrThrow({
      where: { id: reportId },
      include: { lesson: { include: lessonContext } },
    });
    const { lesson } = report;

    const fields: [string, string | null][] = [
      ['Тема', report.topic],
      ['Что делали', report.covered],
      ['Итог', report.results],
      ['Домашнее задание', report.homework],
      ['Следующий шаг', report.recommendations],
      ['Комментарий для родителя', report.parentComment],
    ];
    const reportBody = fields
      .filter(([, value]) => value)
      .map(([label, value]) => `<b>${label}:</b> ${clip(value!, 500)}`)
      .join('\n\n');
    const text = [
      '📝 <b>Отчёт по занятию</b>',
      this.header(lesson),
      `👩‍🏫 ${fullName(lesson.teacher.user)}`,
      '',
      reportBody,
      ...(edited
        ? ['', `✏️ <i>Изменён ${formatDateTime(report.updatedAt)}</i>`]
        : []),
    ].join('\n');

    await this.telegram.enqueue(
      {
        recipient: {
          kind: TelegramRecipientKind.GROUP,
          id: lesson.student.userId,
        },
        occurrenceKey: 'report',
        type: NotificationType.LESSON_REPORT,
        entityId: reportId,
        text,
      },
      db,
    );

    const attachments = await db.material.findMany({
      where: { reportId: report.id, sentToTelegram: false },
      select: { id: true },
      orderBy: { uploadedAt: 'asc' },
    });
    for (const attachment of attachments) {
      await this.enqueueMaterial(attachment.id, db);
    }
  }

  /** Отправляет уведомление о добавлении материала к занятию в группу ученика. */
  async materialAdded(
    materialId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.persist('materialAdded', db, async () => {
      await this.enqueueMaterial(materialId, db);
    });
  }

  private async enqueueMaterial(
    materialId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const material = await db.material.findUniqueOrThrow({
      where: { id: materialId },
      select: {
        title: true,
        reportId: true,
        lesson: { include: lessonContext },
      },
    });
    const { lesson } = material;
    if (!lesson) return;
    await this.telegram.enqueue(
      {
        recipient: {
          kind: TelegramRecipientKind.GROUP,
          id: lesson.student.userId,
        },
        occurrenceKey: 'material',
        type: NotificationType.MATERIAL_ADDED,
        entityId: materialId,
        text: [
          material.reportId
            ? '📎 <b>Вложение к отчёту</b>'
            : '📎 <b>Новый материал к занятию</b>',
          this.header(lesson),
          '',
          `<b>${esc(material.title)}</b>`,
        ].join('\n'),
      },
      db,
    );
  }

  /** Отправляет уведомление об отмене занятия в группу ученика. */
  async lessonCanceled(
    lessonId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.persist('lessonCanceled', db, async () => {
      const lesson = await db.lesson.findUniqueOrThrow({
        where: { id: lessonId },
        include: lessonContext,
      });
      await this.telegram.enqueue(
        {
          recipient: {
            kind: TelegramRecipientKind.GROUP,
            id: lesson.student.userId,
          },
          occurrenceKey: 'cancel',
          type: NotificationType.LESSON_CANCEL,
          entityId: lessonId,
          text: ['❌ <b>Занятие отменено</b>', this.header(lesson)].join('\n'),
        },
        db,
      );
    });
  }

  /** Отправляет уведомление о переносе занятия в группу ученика. */
  async lessonRescheduled(
    lessonId: string,
    from: Date,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.persist('lessonRescheduled', db, async () => {
      const lesson = await db.lesson.findUniqueOrThrow({
        where: { id: lessonId },
        include: { ...lessonContext, rescheduledTo: true },
      });
      const target = lesson.rescheduledTo ?? lesson;
      await this.telegram.enqueue(
        {
          recipient: {
            kind: TelegramRecipientKind.GROUP,
            id: lesson.student.userId,
          },
          occurrenceKey: from.toISOString(),
          type: NotificationType.LESSON_RESCHEDULE,
          entityId: lessonId,
          text: [
            '🔄 <b>Занятие перенесено</b>',
            `📚 ${esc(lesson.enrollment.course.name)} · ${fullName(lesson.student.user)}`,
            `🗓 <s>${formatDateTime(from)}</s> → <b>${formatDateTime(target.scheduledAt)}</b> (МСК)`,
            this.lessonLink(target.id),
          ].join('\n'),
        },
        db,
      );
    });
  }

  /** Создает или обновляет сообщение с заявкой на перенос/отмену в группе ученика. */
  async rescheduleRequestChanged(
    requestId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.persist('rescheduleRequestChanged', db, async () => {
      const request = await db.rescheduleRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          lesson: { include: lessonContext },
          createdBy: true,
          resolvedBy: true,
        },
      });
      const { lesson } = request;

      const isCancel = request.type === RescheduleRequestType.CANCEL;
      const fromTeacher = request.createdById === lesson.teacherId;
      const pending = request.status === RescheduleRequestStatus.PENDING;
      const status = {
        [RescheduleRequestStatus.PENDING]: `⏳ Ждёт подтверждения: ${fromTeacher ? 'ученик' : 'преподаватель'} или менеджер`,
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
        `👤 ${fullName(request.createdBy)} (${fromTeacher ? 'преподаватель' : 'ученик'})`,
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

      await this.telegram.enqueue(
        {
          recipient: {
            kind: TelegramRecipientKind.GROUP,
            id: lesson.student.userId,
          },
          occurrenceKey: 'request',
          type: NotificationType.RESCHEDULE_REQUEST,
          entityId: requestId,
          text,
          replyMarkup: pending ? replyMarkup : null,
        },
        db,
      );
    });
  }

  /** Отправляет напоминания о занятиях за сутки и за 15 минут. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sendLessonReminders() {
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

      for (const lesson of lessons) {
        await this.telegram.enqueue({
          recipient: {
            kind: TelegramRecipientKind.GROUP,
            id: lesson.student.userId,
          },
          occurrenceKey: lesson.scheduledAt.toISOString(),
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

  /** Отправляет сотрудникам напоминания о днях рождения учеников. */
  @Cron('0 9 * * *', { timeZone: MOSCOW_TIME_ZONE })
  async sendBirthdayReminders() {
    const today = DateTime.now().setZone(MOSCOW_TIME_ZONE).startOf('day');
    const students = await this.prisma.studentProfile.findMany({
      where: { user: { isActive: true, birthDate: { not: null } } },
      select: {
        userId: true,
        user: { select: { firstName: true, lastName: true, birthDate: true } },
      },
    });
    const staff = await this.prisma.user.findMany({
      where: {
        isActive: true,
        telegramChatId: { not: null },
        staffRoles: { hasSome: [Role.ADMIN, Role.MANAGER] },
      },
      select: { id: true },
    });
    if (!staff.length) return;

    for (const reminder of BIRTHDAY_REMINDERS) {
      const date = today.plus({ days: reminder.daysBefore });
      const matchingStudents = students.filter(({ user }) => {
        const { birthDate } = user;
        const birthday = DateTime.fromJSDate(birthDate!, { zone: 'utc' });
        return birthday.month === date.month && birthday.day === date.day;
      });
      if (!matchingStudents.length) continue;

      for (const student of matchingStudents) {
        const entityId = `${student.userId}:${date.year}`;

        const text = [
          reminder.title,
          `👤 ${fullName(student.user)}`,
          `📅 ${formatDate(student.user.birthDate!)}`,
        ].join('\n');
        for (const { id: userId } of staff) {
          await this.telegram.enqueue({
            recipient: { kind: TelegramRecipientKind.USER, id: userId },
            occurrenceKey: date.toISODate()!,
            type: reminder.type,
            entityId,
            text,
          });
        }
      }
    }
  }

  /** Отправляет уведомление о расчете или переводе выплаты преподавателю. */
  async payoutChanged(
    payoutId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.persist('payoutChanged', db, async () => {
      const payout = await db.payout.findUniqueOrThrow({
        where: { id: payoutId },
        include: { teacher: { include: { user: true } } },
      });
      // исключаем правую границу диапазона [start, end)
      const periodEnd = new Date(payout.periodEnd.getTime() - 1);
      await this.telegram.enqueue(
        {
          recipient: {
            kind: TelegramRecipientKind.USER,
            id: payout.teacher.userId,
          },
          occurrenceKey: 'payout',
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
        },
        db,
      );
    });
  }

  /** Сохраняет событие в транзакции либо логирует ошибку старого вызова без транзакции. */
  private async persist(
    name: string,
    db: Prisma.TransactionClient,
    job: () => Promise<void>,
  ) {
    try {
      await job();
    } catch (error) {
      if (db !== this.prisma) throw error;
      this.logger.error(`Telegram notification ${name} failed`, error);
    }
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
