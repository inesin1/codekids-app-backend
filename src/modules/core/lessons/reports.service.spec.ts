import { ConfigService } from '@nestjs/config';
import {
  LessonReportStatus,
  LessonStatus,
  Prisma,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { ReportsService } from './reports.service';

type UpdateArgs = [unknown];

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: {
    lesson: { findUnique: jest.Mock };
    lessonReport: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock<Promise<unknown>, UpdateArgs>;
    };
    $transaction: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let notifier: { queueReport: jest.Mock };
  const now = new Date('2026-09-19T10:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      lesson: { findUnique: jest.fn() },
      lessonReport: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn<Promise<unknown>, UpdateArgs>(),
      },
      $transaction: jest.fn(
        (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
      ),
    };
    audit = { log: jest.fn() };
    notifier = { queueReport: jest.fn().mockResolvedValue(undefined) };
    service = new ReportsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
      {
        get: (key: string) => (key === 'BONUS_AMOUNT' ? 50 : undefined),
      } as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('должен создавать черновик без отправки в Telegram', async () => {
    prisma.lesson.findUnique.mockResolvedValue({
      status: LessonStatus.COMPLETED,
      report: null,
    });
    prisma.lessonReport.create.mockResolvedValue({ id: 'r1' });
    const dto = {
      topic: 'Циклы',
      covered: 'Решали задачи',
      results: 'Разобрался с for',
    };

    await service.create('l1', dto);

    expect(prisma.lessonReport.create).toHaveBeenCalledWith({
      data: { lessonId: 'l1', ...dto },
    });
    expect(notifier.queueReport).not.toHaveBeenCalled();
  });

  it('должен начислять бонус и ставить отчет в очередь при первой отправке', async () => {
    prisma.lessonReport.findUnique.mockResolvedValue({
      id: 'r1',
      submittedAt: null,
      bonusApplied: false,
      bonusAmount: null,
      lesson: { completedAt: new Date(now.getTime() - 60 * 60 * 1000) },
    });
    prisma.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.submit('l1');

    const update = prisma.lessonReport.update.mock.calls[0][0] as {
      data: {
        status: LessonReportStatus;
        submittedAt: Date;
        sentToTelegram: boolean;
        bonusApplied: boolean;
        bonusAmount: Prisma.Decimal;
      };
    };
    expect(update.data.status).toBe(LessonReportStatus.SUBMITTED);
    expect(update.data.submittedAt).toEqual(now);
    expect(update.data.sentToTelegram).toBe(false);
    expect(update.data.bonusApplied).toBe(true);
    expect(update.data.bonusAmount.toString()).toBe('50');
    expect(notifier.queueReport).toHaveBeenCalledWith('r1', false, prisma);
  });

  it('должен возвращать отредактированный отчет в черновики', async () => {
    prisma.lessonReport.findUnique.mockResolvedValue({
      id: 'r1',
      lesson: { completedAt: now },
    });
    prisma.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.update('l1', { topic: 'Новая тема' });

    expect(prisma.lessonReport.update).toHaveBeenCalledWith({
      where: { lessonId: 'l1' },
      data: {
        topic: 'Новая тема',
        status: LessonReportStatus.DRAFT,
        sentToTelegram: false,
      },
    });
    expect(notifier.queueReport).not.toHaveBeenCalled();
  });
});
