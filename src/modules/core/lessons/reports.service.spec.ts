import { BadRequestException, ConflictException } from '@nestjs/common';
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

type TxMock = {
  $queryRaw: jest.Mock;
  lesson: { findUnique: jest.Mock };
  lessonReport: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  payout: { findFirst: jest.Mock };
};

describe('ReportsService', () => {
  let service: ReportsService;
  let tx: TxMock;
  let prisma: { $transaction: jest.Mock };
  let audit: { record: jest.Mock };
  let notifier: { queueReport: jest.Mock };

  const now = new Date('2026-09-19T10:00:00.000Z');
  const scheduledAt = new Date('2026-09-18T13:30:00.000Z');
  const completedAt = new Date(now.getTime() - 60 * 60 * 1000);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      lesson: { findUnique: jest.fn() },
      lessonReport: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      payout: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    prisma = {
      $transaction: jest.fn(
        (callback: (transaction: TxMock) => Promise<unknown>) => callback(tx),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifier = { queueReport: jest.fn().mockResolvedValue(undefined) };
    service = new ReportsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
      {
        get: (key: string) =>
          key === 'BONUS_AMOUNT'
            ? '0.10'
            : key === 'BONUS_WINDOW_HOURS'
              ? '24'
              : undefined,
      } as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a draft and its mandatory audit in one transaction', async () => {
    tx.lesson.findUnique.mockResolvedValue({
      status: LessonStatus.COMPLETED,
      report: null,
    });
    tx.lessonReport.create.mockResolvedValue({ id: 'r1' });
    const dto = {
      topic: 'Циклы',
      covered: 'Решали задачи',
      results: 'Разобрался с for',
    };

    await service.create('l1', dto);

    expect(tx.lessonReport.create).toHaveBeenCalledWith({
      data: { lessonId: 'l1', ...dto },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lesson_report.created' }),
      tx,
    );
    expect(notifier.queueReport).not.toHaveBeenCalled();
  });

  it('awards an exact Decimal bonus and writes the outbox and audit in one transaction', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({
        id: 'r1',
        lesson: { teacherId: 't1' },
      })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: null,
        bonusApplied: false,
        bonusAmount: null,
        lesson: {
          teacherId: 't1',
          status: LessonStatus.COMPLETED,
          completedAt,
          scheduledAt,
        },
      });
    tx.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.submit('l1');

    const updateCalls = tx.lessonReport.update.mock.calls as unknown as [
      {
        data: {
          status: LessonReportStatus;
          submittedAt: Date;
          sentToTelegram: boolean;
          bonusApplied: boolean;
          bonusAmount: Prisma.Decimal;
        };
      },
    ][];
    const update = updateCalls[0][0];
    expect(update.data.status).toBe(LessonReportStatus.SUBMITTED);
    expect(update.data.submittedAt).toEqual(now);
    expect(update.data.sentToTelegram).toBe(false);
    expect(update.data.bonusApplied).toBe(true);
    expect(update.data.bonusAmount.toString()).toBe('0.1');
    expect(tx.payout.findFirst).toHaveBeenCalledWith({
      where: {
        teacherId: 't1',
        periodStart: { lte: scheduledAt },
        periodEnd: { gt: scheduledAt },
      },
      select: { id: true },
    });
    expect(notifier.queueReport).toHaveBeenCalledWith('r1', false, tx);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lesson_report.submitted',
        details: { lessonId: 'l1', bonusApplied: true },
      }),
      tx,
    );
  });

  it('does not award a first-submission bonus after a payout finalized its period', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({
        id: 'r1',
        lesson: { teacherId: 't1' },
      })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: null,
        bonusApplied: false,
        bonusAmount: null,
        lesson: {
          teacherId: 't1',
          status: LessonStatus.COMPLETED,
          completedAt,
          scheduledAt,
        },
      });
    tx.payout.findFirst.mockResolvedValue({ id: 'p1' });
    tx.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.submit('l1');

    const updateCalls = tx.lessonReport.update.mock.calls as unknown as [
      { data: { bonusApplied: boolean; bonusAmount?: Prisma.Decimal } },
    ][];
    const update = updateCalls[0][0];
    expect(update.data.bonusApplied).toBe(false);
    expect(update.data.bonusAmount).toBeUndefined();
  });

  it('does not award bonuses outside the current window', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({
        id: 'r1',
        lesson: { teacherId: 't1' },
      })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: null,
        bonusApplied: false,
        bonusAmount: null,
        lesson: {
          teacherId: 't1',
          status: LessonStatus.COMPLETED,
          completedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
        },
      });
    tx.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.submit('l1');

    expect(tx.payout.findFirst).not.toHaveBeenCalled();
    const updateCalls = tx.lessonReport.update.mock.calls as unknown as [
      { data: { bonusApplied: boolean } },
    ][];
    const update = updateCalls[0][0];
    expect(update.data.bonusApplied).toBe(false);
  });

  it('returns unchanged submitted reports without duplicate audit or outbox events', async () => {
    const submittedAt = new Date('2026-09-19T09:00:00.000Z');
    const report = {
      id: 'r1',
      status: LessonReportStatus.SUBMITTED,
      submittedAt,
      lesson: {
        teacherId: 't1',
        status: LessonStatus.COMPLETED,
        completedAt,
      },
    };
    const unchanged = {
      id: 'r1',
      status: LessonReportStatus.SUBMITTED,
      submittedAt,
    };
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1', lesson: { teacherId: 't1' } })
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce(unchanged);

    await expect(service.submit('l1')).resolves.toBe(unchanged);

    expect(tx.lessonReport.update).not.toHaveBeenCalled();
    expect(notifier.queueReport).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.payout.findFirst).not.toHaveBeenCalled();
  });

  it('resubmits edited reports as a new Telegram message version', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1', lesson: { teacherId: 't1' } })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: new Date(now.getTime() - 10 * 60 * 1000),
        bonusApplied: true,
        bonusAmount: new Prisma.Decimal('0.1'),
        lesson: {
          teacherId: 't1',
          status: LessonStatus.COMPLETED,
          completedAt,
        },
      });
    tx.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.submit('l1');

    expect(notifier.queueReport).toHaveBeenCalledWith('r1', true, tx);
    expect(tx.payout.findFirst).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('returns an edited report to drafts with an audit in one transaction', async () => {
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1' })
      .mockResolvedValueOnce({ id: 'r1', lesson: { completedAt } });
    tx.lessonReport.update.mockResolvedValue({ id: 'r1' });

    await service.update('l1', { topic: 'Новая тема' });

    expect(tx.lessonReport.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: {
        topic: 'Новая тема',
        status: LessonReportStatus.DRAFT,
        sentToTelegram: false,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lesson_report.updated' }),
      tx,
    );
    expect(notifier.queueReport).not.toHaveBeenCalled();
  });

  it('keeps the existing report edit-window policy', async () => {
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1' })
      .mockResolvedValueOnce({
        id: 'r1',
        lesson: { completedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) },
      });

    await expect(
      service.update('l1', { topic: 'Поздняя правка' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.lessonReport.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects submission when lesson is no longer completed', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1', lesson: { teacherId: 't1' } })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: null,
        bonusApplied: false,
        bonusAmount: null,
        lesson: {
          teacherId: 't1',
          status: LessonStatus.CANCELED,
          completedAt,
        },
      });

    await expect(service.submit('l1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.lessonReport.update).not.toHaveBeenCalled();
    expect(notifier.queueReport).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a changed teacher identity instead of locking the wrong profile', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ userId: 't1' }])
      .mockResolvedValueOnce([]);
    tx.lessonReport.findUnique
      .mockResolvedValueOnce({ id: 'r1', lesson: { teacherId: 't1' } })
      .mockResolvedValueOnce({
        id: 'r1',
        status: LessonReportStatus.DRAFT,
        submittedAt: null,
        bonusApplied: false,
        lesson: {
          teacherId: 't2',
          status: LessonStatus.COMPLETED,
          completedAt,
        },
      });

    await expect(service.submit('l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.lessonReport.update).not.toHaveBeenCalled();
  });

  it('rejects negative bonus amounts at construction', () => {
    expect(
      () =>
        new ReportsService(
          prisma as unknown as PrismaService,
          audit as unknown as AuditService,
          notifier as unknown as TelegramNotifier,
          {
            get: (key: string) => (key === 'BONUS_AMOUNT' ? '-0.01' : '24'),
          } as ConfigService,
        ),
    ).toThrow('BONUS_AMOUNT must be a non-negative decimal');
  });

  it('rejects non-finite bonus windows at construction', () => {
    expect(
      () =>
        new ReportsService(
          prisma as unknown as PrismaService,
          audit as unknown as AuditService,
          notifier as unknown as TelegramNotifier,
          {
            get: (key: string) => (key === 'BONUS_AMOUNT' ? '0.10' : 'NaN'),
          } as ConfigService,
        ),
    ).toThrow('BONUS_WINDOW_HOURS must be a non-negative finite number');
  });
});
