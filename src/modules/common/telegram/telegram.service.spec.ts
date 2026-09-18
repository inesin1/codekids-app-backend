import { ConfigService } from '@nestjs/config';
import { GrammyError } from 'grammy';
import {
  NotificationType,
  TelegramNotification,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_ATTEMPTS, TelegramService } from './telegram.service';

const makeRow = (
  overrides: Partial<TelegramNotification> = {},
): TelegramNotification => ({
  id: 'n1',
  chatId: '-100',
  type: NotificationType.LESSON_REPORT,
  entityId: 'r1',
  text: 'текст',
  replyMarkup: null,
  telegramMessageId: null,
  sentAt: null,
  attempts: 0,
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const apiError = (error_code: number, description: string) =>
  new GrammyError(
    description,
    { ok: false, error_code, description },
    'sendMessage',
    {},
  );

describe('TelegramService.flush', () => {
  let service: TelegramService;
  let prisma: {
    telegramNotification: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    lessonReport: { updateMany: jest.Mock };
    rescheduleRequest: { updateMany: jest.Mock };
    telegramGroup: { updateMany: jest.Mock };
    user: { updateMany: jest.Mock };
  };
  let sendMessage: jest.SpyInstance;
  let editMessageText: jest.SpyInstance;
  const now = new Date('2026-09-18T10:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      telegramNotification: {
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      lessonReport: { updateMany: jest.fn() },
      rescheduleRequest: { updateMany: jest.fn() },
      telegramGroup: { updateMany: jest.fn() },
      user: { updateMany: jest.fn() },
    };
    const config = {
      get: (key: string) =>
        key === 'TELEGRAM_BOT_TOKEN' ? '123:test' : undefined,
    } as unknown as ConfigService;
    service = new TelegramService(prisma as unknown as PrismaService, config);
    sendMessage = jest
      .spyOn(service.bot!.api, 'sendMessage')
      .mockResolvedValue({ message_id: 42 } as never);
    editMessageText = jest
      .spyOn(service.bot!.api, 'editMessageText')
      .mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('должен отправлять новое сообщение и помечать отчёт отправленным', async () => {
    // Arrange
    prisma.telegramNotification.findMany.mockResolvedValue([makeRow()]);

    // Act
    await service.flush();

    // Assert
    expect(sendMessage).toHaveBeenCalledWith(
      '-100',
      'текст',
      expect.anything(),
    );
    expect(prisma.telegramNotification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { telegramMessageId: 42 },
    });
    expect(prisma.lessonReport.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { sentToTelegram: true },
    });
    expect(prisma.telegramNotification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', text: 'текст' },
      data: { sentAt: now, error: null },
    });
  });

  it('должен редактировать сообщение, если оно уже отправлено', async () => {
    // Arrange
    prisma.telegramNotification.findMany.mockResolvedValue([
      makeRow({ telegramMessageId: 7 }),
    ]);

    // Act
    await service.flush();

    // Assert
    expect(editMessageText).toHaveBeenCalledWith(
      '-100',
      7,
      'текст',
      expect.anything(),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.lessonReport.updateMany).not.toHaveBeenCalled();
  });

  it('должен считать «message is not modified» успехом', async () => {
    // Arrange
    prisma.telegramNotification.findMany.mockResolvedValue([
      makeRow({ telegramMessageId: 7 }),
    ]);
    editMessageText.mockRejectedValue(
      apiError(400, 'Bad Request: message is not modified'),
    );

    // Act
    await service.flush();

    // Assert
    expect(prisma.telegramNotification.updateMany).toHaveBeenCalled();
    expect(prisma.telegramNotification.update).not.toHaveBeenCalled();
  });

  it('должен прекращать ретраи и деактивировать чат при 403', async () => {
    // Arrange
    prisma.telegramNotification.findMany.mockResolvedValue([makeRow()]);
    const kicked = apiError(
      403,
      'Forbidden: bot was kicked from the group chat',
    );
    sendMessage.mockRejectedValue(kicked);

    // Act
    await service.flush();

    // Assert
    expect(prisma.telegramGroup.updateMany).toHaveBeenCalledWith({
      where: { telegramChatId: '-100' },
      data: { isActive: false },
    });
    expect(prisma.telegramNotification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { attempts: MAX_ATTEMPTS, error: kicked.message },
    });
  });

  it('должен увеличивать счётчик попыток при прочих ошибках', async () => {
    // Arrange
    prisma.telegramNotification.findMany.mockResolvedValue([makeRow()]);
    sendMessage.mockRejectedValue(new Error('network down'));

    // Act
    await service.flush();

    // Assert
    expect(prisma.telegramNotification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { attempts: { increment: 1 }, error: 'network down' },
    });
    expect(prisma.telegramGroup.updateMany).not.toHaveBeenCalled();
  });
});
