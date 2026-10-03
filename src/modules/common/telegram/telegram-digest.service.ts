import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  LessonStatus,
  NotificationType,
  RescheduleRequestStatus,
  Role,
  TelegramRecipientKind,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatDateTime, fullName, money } from './telegram.format';
import { DateTime } from 'luxon';
import { BUSINESS_TIMEZONE } from '../business-time';
import { TelegramService } from './telegram.service';

const HOUR_MS = 60 * 60 * 1000;
const LIST_LIMIT = 5;

const lessonNames = {
  student: { include: { user: true } },
  teacher: { include: { user: true } },
} as const;

/** Формирует и рассылает ежедневную сводку проблем сотрудникам. */
@Injectable()
export class TelegramDigestService {
  private readonly logger = new Logger(TelegramDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /** Отправляет ежедневный дайджест в личные чаты сотрудников (10:00 МСК). */
  @Cron('0 10 * * *', { timeZone: BUSINESS_TIMEZONE })
  async sendDaily() {
    const text = await this.buildText(new Date());
    if (!text) return;

    const staff = await this.prisma.user.findMany({
      where: {
        isActive: true,
        telegramChatId: { not: null },
        staffRoles: { hasSome: [Role.ADMIN, Role.MANAGER] },
      },
      select: { id: true },
    });
    const occurrenceKey = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .toISODate()!;
    for (const { id } of staff) {
      await this.telegram.enqueue({
        recipient: { kind: TelegramRecipientKind.USER, id },
        occurrenceKey,
        type: NotificationType.STAFF_DIGEST,
        entityId: occurrenceKey,
        text,
      });
    }
    this.logger.log(
      `Дайджест поставлен в очередь: ${staff.length} получателей`,
    );
  }

  /** Собирает текст сводки проблем по системе (или null, если проблем нет). */
  async buildText(now: Date) {
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);

    const [
      notMarked,
      notMarkedCount,
      noReport,
      noReportCount,
      staleRequests,
      staleRequestsCount,
      debtors,
      debtorCount,
      studentsWithoutGroup,
      failedNotifications,
    ] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { status: LessonStatus.SCHEDULED, scheduledAt: { lt: ago(3) } },
        include: lessonNames,
        orderBy: { scheduledAt: 'asc' },
        take: LIST_LIMIT,
      }),
      this.prisma.lesson.count({
        where: { status: LessonStatus.SCHEDULED, scheduledAt: { lt: ago(3) } },
      }),
      this.prisma.lesson.findMany({
        where: {
          status: LessonStatus.COMPLETED,
          completedAt: { lt: ago(24) },
          report: { is: null },
        },
        include: lessonNames,
        orderBy: { scheduledAt: 'asc' },
        take: LIST_LIMIT,
      }),
      this.prisma.lesson.count({
        where: {
          status: LessonStatus.COMPLETED,
          completedAt: { lt: ago(24) },
          report: { is: null },
        },
      }),
      this.prisma.rescheduleRequest.findMany({
        where: {
          status: RescheduleRequestStatus.PENDING,
          createdAt: { lt: ago(24) },
        },
        include: { lesson: { include: lessonNames } },
        orderBy: { createdAt: 'asc' },
        take: LIST_LIMIT,
      }),
      this.prisma.rescheduleRequest.count({
        where: {
          status: RescheduleRequestStatus.PENDING,
          createdAt: { lt: ago(24) },
        },
      }),
      this.prisma.studentProfile.findMany({
        where: { balance: { lt: 0 } },
        include: { user: true },
        orderBy: { balance: 'asc' },
        take: LIST_LIMIT,
      }),
      this.prisma.studentProfile.count({ where: { balance: { lt: 0 } } }),
      this.prisma.studentProfile.count({
        where: {
          user: { isActive: true },
          enrollments: { some: { isActive: true } },
          OR: [
            { telegramGroup: { is: null } },
            { telegramGroup: { isActive: false } },
          ],
        },
      }),
      this.prisma.telegramNotification.count({
        where: {
          failedAt: { not: null },
          updatedAt: { gte: ago(24) },
        },
      }),
    ]);

    const lessonLine = (l: (typeof notMarked)[number]) =>
      `• ${formatDateTime(l.scheduledAt)} — ${fullName(l.student.user)} (преп. ${fullName(l.teacher.user)})`;

    const sections = [
      this.section(
        '⏰ Занятия прошли, но не отмечены',
        notMarked.map(lessonLine),
        notMarkedCount,
      ),
      this.section(
        '📝 Нет отчёта больше суток',
        noReport.map(lessonLine),
        noReportCount,
      ),
      this.section(
        '🔄 Заявки ждут решения больше суток',
        staleRequests.map((r) => lessonLine(r.lesson)),
        staleRequestsCount,
      ),
      this.section(
        '💸 Ученики с задолженностью',
        debtors.map((p) => `• ${fullName(p.user)}: ${money(p.balance)}`),
        debtorCount,
      ),
      studentsWithoutGroup
        ? `👥 Ученики без Telegram-группы: <b>${studentsWithoutGroup}</b>`
        : '',
      failedNotifications
        ? `⚠️ Не доставлено уведомлений за сутки: <b>${failedNotifications}</b>`
        : '',
    ].filter(Boolean);

    if (!sections.length) return null;
    return ['📋 <b>Сводка проблем</b>', ...sections].join('\n\n');
  }

  private section(title: string, lines: string[], count = lines.length) {
    if (!lines.length) return '';
    const rest = count - lines.length;
    return [
      `${title}: <b>${count}</b>`,
      ...lines,
      ...(rest > 0 ? [`…и ещё ${rest}`] : []),
    ].join('\n');
  }
}
