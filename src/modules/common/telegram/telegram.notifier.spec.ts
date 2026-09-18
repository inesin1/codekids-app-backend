import { ConfigService } from '@nestjs/config';
import { NotificationType } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramNotifier } from './telegram.notifier';
import { TelegramService } from './telegram.service';
import { describe } from 'node:test';

const MINUTE_MS = 60 * 1000;

const makeLesson = (id: string, scheduledAt: Date) => ({
  id,
  scheduledAt,
  student: {
    user: { firstName: 'Иван', lastName: 'Петров' },
    telegramGroup: { telegramChatId: '-100', isActive: true },
  },
  teacher: { user: { firstName: 'Анна', lastName: 'Смирнова' } },
  enrollment: { course: { name: 'Python' } },
});

describe('TelegramNotifier.sendLessonReminders', () => {
  let notifier: TelegramNotifier;
  let prisma: {
    lesson: { findMany: jest.Mock };
    telegramNotification: { findMany: jest.Mock };
  };
  let telegram: { enabled: boolean; enqueue: jest.Mock };
  const now = new Date('2026-09-18T10:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      lesson: { findMany: jest.fn().mockResolvedValue([]) },
      telegramNotification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    telegram = { enabled: true, enqueue: jest.fn() };
    notifier = new TelegramNotifier(
      prisma as unknown as PrismaService,
      telegram as unknown as TelegramService,
      { get: () => undefined } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('должен искать занятия в окнах (23ч, 24ч] и (0, 15мин]', async () => {
    await notifier.sendLessonReminders();

    const windows = prisma.lesson.findMany.mock.calls.map(
      ([args]: [{ where: { scheduledAt: { gt: Date; lte: Date } } }]) =>
        args.where.scheduledAt,
    );
    expect(windows).toEqual([
      {
        gt: new Date(now.getTime() + 23 * 60 * MINUTE_MS),
        lte: new Date(now.getTime() + 24 * 60 * MINUTE_MS),
      },
      { gt: now, lte: new Date(now.getTime() + 15 * MINUTE_MS) },
    ]);
  });

  it('не должен повторно слать напоминание по тому же занятию', async () => {
    const soon = new Date(now.getTime() + 10 * MINUTE_MS);
    prisma.lesson.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeLesson('l1', soon), makeLesson('l2', soon)]);
    prisma.telegramNotification.findMany.mockResolvedValue([
      { entityId: 'l1' },
    ]);

    await notifier.sendLessonReminders();

    expect(telegram.enqueue).toHaveBeenCalledTimes(1);
    expect(telegram.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        type: NotificationType.LESSON_REMINDER_SOON,
        entityId: 'l2',
      }),
    );
  });

  it('не должен ничего делать при выключенной интеграции', async () => {
    telegram.enabled = false;

    await notifier.sendLessonReminders();

    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });
});
