import { ConfigService } from '@nestjs/config';
import { NotificationType } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramNotifier } from './telegram.notifier';
import { TelegramService } from './telegram.service';

const MINUTE_MS = 60 * 1000;
type UpdateMessageArgs = [NotificationType, string, { text: string }, unknown?];
type EnqueueArgs = [
  {
    chatId: string;
    type: NotificationType;
    entityId?: string;
    text: string;
  },
  unknown?,
];

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
    studentProfile: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
    lessonReport: { findUniqueOrThrow: jest.Mock };
    material: { findMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    telegramNotification: { findMany: jest.Mock };
  };
  let telegram: {
    enabled: boolean;
    enqueue: jest.Mock<Promise<void>, EnqueueArgs>;
    updateMessage: jest.Mock<Promise<boolean>, UpdateMessageArgs>;
  };
  const now = new Date('2026-09-18T10:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      lesson: { findMany: jest.fn().mockResolvedValue([]) },
      studentProfile: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      lessonReport: { findUniqueOrThrow: jest.fn() },
      material: {
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn(),
      },
      telegramNotification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    telegram = {
      enabled: true,
      enqueue: jest.fn<Promise<void>, EnqueueArgs>().mockResolvedValue(),
      updateMessage: jest
        .fn<Promise<boolean>, UpdateMessageArgs>()
        .mockResolvedValue(true),
    };
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

  it('должен отправлять напоминание о дне рождения всем подключённым сотрудникам', async () => {
    prisma.studentProfile.findMany.mockResolvedValue([
      {
        userId: 's1',
        user: {
          firstName: 'Иван',
          lastName: 'Петров',
          birthDate: new Date('2015-09-25T00:00:00.000Z'),
        },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { telegramChatId: '10' },
      { telegramChatId: '20' },
    ]);

    await notifier.sendBirthdayReminders();

    expect(telegram.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '10',
        type: NotificationType.BIRTHDAY_REMINDER_WEEK,
        entityId: 's1:2026',
      }),
    );
    expect(telegram.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '20' }),
    );
  });

  it('не должен повторно отправлять напоминание о дне рождения в том же году', async () => {
    prisma.studentProfile.findMany.mockResolvedValue([
      {
        userId: 's1',
        user: {
          firstName: 'Иван',
          lastName: 'Петров',
          birthDate: new Date('2015-09-25T00:00:00.000Z'),
        },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ telegramChatId: '10' }]);
    prisma.telegramNotification.findMany.mockResolvedValue([
      { entityId: 's1:2026' },
    ]);

    await notifier.sendBirthdayReminders();

    expect(telegram.enqueue).not.toHaveBeenCalled();
  });

  it('должен разделять пункты отчёта и не добавлять ссылку', async () => {
    const createdAt = new Date('2026-09-18T09:00:00Z');
    prisma.lessonReport.findUniqueOrThrow.mockResolvedValue({
      id: 'r1',
      topic: 'Циклы',
      covered: 'Решали задачи',
      results: 'Разобрался с for',
      homework: null,
      recommendations: 'Перейти к while',
      parentComment: null,
      createdAt,
      updatedAt: createdAt,
      lesson: makeLesson('l1', createdAt),
    });

    await notifier.queueReport('r1');

    const text = telegram.updateMessage.mock.calls[0][2].text;
    expect(text).toContain(
      '<b>Тема:</b> Циклы\n\n<b>Что делали:</b> Решали задачи\n\n<b>Итог:</b> Разобрался с for',
    );
    expect(text).not.toContain('Открыть в личном кабинете');
    expect(text).not.toContain('<a href=');
  });

  it('должен ставить вложения в очередь после отчёта', async () => {
    const createdAt = new Date('2026-09-18T09:00:00Z');
    const lesson = makeLesson('l1', createdAt);
    prisma.lessonReport.findUniqueOrThrow.mockResolvedValue({
      id: 'r1',
      topic: 'Циклы',
      covered: 'Решали задачи',
      results: 'Разобрался с for',
      homework: null,
      recommendations: 'Перейти к while',
      parentComment: null,
      createdAt,
      updatedAt: createdAt,
      lesson,
    });
    prisma.material.findMany.mockResolvedValue([{ id: 'm1' }]);
    prisma.material.findUniqueOrThrow.mockResolvedValue({
      title: 'lesson.pdf',
      reportId: 'r1',
      lesson,
    });
    telegram.updateMessage.mockResolvedValue(false);

    await notifier.queueReport('r1');

    expect(telegram.enqueue.mock.calls[0][0]).toMatchObject({
      type: NotificationType.LESSON_REPORT,
      entityId: 'r1',
    });
    expect(telegram.enqueue.mock.calls[1][0]).toMatchObject({
      chatId: '-100',
      type: NotificationType.MATERIAL_ADDED,
      entityId: 'm1',
    });
    expect(telegram.enqueue.mock.calls[1][0].text).toContain(
      'Вложение к отчёту',
    );
    expect(telegram.updateMessage.mock.calls[1].slice(0, 2)).toEqual([
      NotificationType.MATERIAL_ADDED,
      'm1',
    ]);
    expect(telegram.updateMessage.mock.calls[1][2].text).toContain(
      'Вложение к отчёту',
    );
  });
});
