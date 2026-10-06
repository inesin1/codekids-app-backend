import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  Prisma,
  TelegramRecipientKind,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramNotifier } from './telegram.notifier';
import { TelegramOutboxEvent, TelegramService } from './telegram.service';

const MINUTE_MS = 60 * 1000;

const makeLesson = (id: string, scheduledAt: Date) => ({
  id,
  scheduledAt,
  student: {
    userId: 'student-1',
    user: { firstName: 'Иван', lastName: 'Петров' },
    telegramGroup: { telegramChatId: '-100', isActive: true },
  },
  teacher: {
    userId: 'teacher-1',
    user: { firstName: 'Анна', lastName: 'Смирнова' },
  },
  enrollment: { course: { name: 'Python' } },
});

describe('TelegramNotifier transactional events', () => {
  it('logs legacy post-commit errors but propagates transactional failures', async () => {
    const error = new Error('outbox unavailable');
    const db = {
      payout: { findUniqueOrThrow: jest.fn().mockRejectedValue(error) },
    };
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const notifier = new TelegramNotifier(
      db as unknown as PrismaService,
      { enqueue: jest.fn() } as unknown as TelegramService,
      { get: () => undefined } as unknown as ConfigService,
    );
    try {
      await expect(notifier.payoutChanged('payout')).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      const tx = { ...db } as unknown as Prisma.TransactionClient;
      await expect(notifier.payoutChanged('payout', tx)).rejects.toBe(error);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('uses owner identity and an occurrence key for lesson reminders without checking bot readiness', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-18T10:00:00Z'));
    const soon = new Date(Date.now() + 10 * MINUTE_MS);
    const prisma = {
      lesson: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([makeLesson('l1', soon)]),
      },
    };
    const telegram = {
      enabled: false,
      enqueue: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = new TelegramNotifier(
      prisma as unknown as PrismaService,
      telegram as unknown as TelegramService,
      { get: () => undefined } as unknown as ConfigService,
    );

    try {
      await notifier.sendLessonReminders();
      expect(telegram.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: { kind: TelegramRecipientKind.GROUP, id: 'student-1' },
          occurrenceKey: soon.toISOString(),
          type: NotificationType.LESSON_REMINDER_SOON,
          entityId: 'l1',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fans birthday reminders out independently to staff user owners', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-18T07:00:00Z'));
    const prisma = {
      studentProfile: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'student-1',
            user: {
              firstName: 'Иван',
              lastName: 'Петров',
              birthDate: new Date('2015-09-25T00:00:00Z'),
            },
          },
        ]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'staff-1' }]) },
    };
    const enqueue = jest
      .fn<Promise<void>, [event: TelegramOutboxEvent, db?: unknown]>()
      .mockResolvedValue(undefined);
    const telegram = { enqueue };
    const notifier = new TelegramNotifier(
      prisma as unknown as PrismaService,
      telegram as unknown as TelegramService,
      { get: () => undefined } as unknown as ConfigService,
    );

    try {
      await notifier.sendBirthdayReminders();
      expect(telegram.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: { kind: TelegramRecipientKind.USER, id: 'staff-1' },
          occurrenceKey: '2026-09-25',
          entityId: 'student-1:2026',
          type: NotificationType.BIRTHDAY_REMINDER_WEEK,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('upserts an edited report event and queues its unsent attachments', async () => {
    const createdAt = new Date('2026-09-18T09:00:00Z');
    const lesson = makeLesson('l1', createdAt);
    const prisma = {
      lessonReport: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'r1',
          topic: 'Циклы',
          covered: 'Решали задачи',
          results: 'Разобрался с for',
          homework: null,
          recommendations: 'Перейти к while',
          parentComment: null,
          updatedAt: createdAt,
          lesson,
        }),
      },
      material: {
        findMany: jest.fn().mockResolvedValue([{ id: 'm1' }]),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          title: 'lesson.pdf',
          reportId: 'r1',
          lesson,
        }),
      },
    };
    const enqueue = jest
      .fn<Promise<void>, [event: TelegramOutboxEvent, db?: unknown]>()
      .mockResolvedValue(undefined);
    const telegram = { enqueue };
    const notifier = new TelegramNotifier(
      prisma as unknown as PrismaService,
      telegram as unknown as TelegramService,
      { get: () => undefined } as unknown as ConfigService,
    );

    await notifier.queueReport('r1', true);

    const reportEvent = telegram.enqueue.mock.calls[0]?.[0];
    expect(reportEvent?.recipient).toEqual({
      kind: TelegramRecipientKind.GROUP,
      id: 'student-1',
    });
    expect(reportEvent?.occurrenceKey).toBe('report');
    expect(reportEvent?.type).toBe(NotificationType.LESSON_REPORT);
    expect(reportEvent?.entityId).toBe('r1');
    expect(reportEvent?.text).toContain('<b>Тема занятия:</b> Циклы');
    expect(reportEvent?.text).toContain('<b>Домашнее задание:</b> Нет');
    expect(reportEvent?.text).not.toContain('Следующий шаг');

    const materialEvent = telegram.enqueue.mock.calls[1]?.[0];
    expect(materialEvent?.recipient).toEqual({
      kind: TelegramRecipientKind.GROUP,
      id: 'student-1',
    });
    expect(materialEvent?.type).toBe(NotificationType.MATERIAL_ADDED);
    expect(materialEvent?.entityId).toBe('m1');
    expect(materialEvent?.text).toContain('Вложение к отчёту');
  });
});
