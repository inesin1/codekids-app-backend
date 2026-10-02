import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PayoutStatus, Prisma } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { PayoutsService } from './payouts.service';

type TxMock = {
  $queryRaw: jest.Mock;
  payout: {
    findFirst: jest.Mock;
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  lesson: { findMany: jest.Mock };
};

describe('PayoutsService.calculate', () => {
  let service: PayoutsService;
  let tx: TxMock;
  let audit: { record: jest.Mock };
  let notifier: { payoutChanged: jest.Mock };
  let prisma: { $transaction: jest.Mock; lesson: { findMany: jest.Mock } };

  const now = new Date('2026-10-02T10:00:00.000Z');
  const dto = {
    teacherId: 't1',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ userId: 't1' }]),
      payout: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      lesson: { findMany: jest.fn() },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifier = { payoutChanged: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      $transaction: jest.fn(
        (callback: (transaction: TxMock) => Promise<unknown>) => callback(tx),
      ),
      lesson: { findMany: jest.fn() },
    };
    service = new PayoutsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
      { get: () => '24' } as never,
    );
    tx.payout.findFirst.mockResolvedValue(null);
    tx.lesson.findMany.mockResolvedValue([]);
    tx.payout.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: 'p1', ...data }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serializes before overlap checks and persists exact Decimal totals with audit/outbox', async () => {
    const events: string[] = [];
    tx.$queryRaw.mockImplementation(() => {
      events.push('teacher-lock');
      return Promise.resolve([{ userId: 't1' }]);
    });
    tx.payout.findFirst.mockImplementation(() => {
      events.push('overlap-check');
      return Promise.resolve(null);
    });
    tx.lesson.findMany.mockImplementation(() => {
      events.push('lessons');
      return Promise.resolve([
        {
          completedAt: new Date('2026-06-15T10:00:00.000Z'),
          teacherRate: new Prisma.Decimal('100.10'),
          report: {
            bonusApplied: true,
            bonusAmount: new Prisma.Decimal('0.25'),
          },
        },
        {
          completedAt: new Date('2026-06-16T10:00:00.000Z'),
          teacherRate: new Prisma.Decimal('0.20'),
          report: null,
        },
      ]);
    });
    tx.payout.create.mockImplementation(({ data }: { data: object }) => {
      events.push('create');
      return Promise.resolve({
        id: 'p1',
        totalPay: new Prisma.Decimal('100.55'),
        ...data,
      });
    });
    audit.record.mockImplementation((_entry, db) => {
      events.push('audit');
      expect(db).toBe(tx);
      return Promise.resolve(undefined);
    });
    notifier.payoutChanged.mockImplementation((_id, db) => {
      events.push('outbox');
      expect(db).toBe(tx);
      return Promise.resolve(undefined);
    });

    const payout = await service.calculate(dto);

    const createCalls = tx.payout.create.mock.calls as unknown as [
      {
        data: {
          basePay: Prisma.Decimal;
          bonusPay: Prisma.Decimal;
          totalPay: Prisma.Decimal;
        };
      },
    ][];
    const data = createCalls[0][0].data;
    expect(data.basePay.toString()).toBe('100.3');
    expect(data.bonusPay.toString()).toBe('0.25');
    expect(data.totalPay.toString()).toBe('100.55');
    expect(payout.id).toBe('p1');
    expect(events).toEqual([
      'teacher-lock',
      'overlap-check',
      'lessons',
      'create',
      'audit',
      'outbox',
    ]);
    const auditCalls = audit.record.mock.calls as unknown as [
      { details: { totalPay: string } },
      TxMock,
    ][];
    expect(auditCalls[0][0].details.totalPay).toBe('100.55');
    expect(notifier.payoutChanged).toHaveBeenCalledWith('p1', tx);
  });

  it('uses the half-open lesson interval [start, end)', async () => {
    await service.calculate(dto);

    expect(tx.lesson.findMany).toHaveBeenCalledWith({
      where: {
        teacherId: dto.teacherId,
        status: 'COMPLETED',
        completedAt: {
          gte: new Date(dto.periodStart),
          lt: new Date(dto.periodEnd),
        },
      },
      include: { report: true },
    });
  });

  it('rejects a period that has not closed after locking the teacher', async () => {
    await expect(
      service.calculate({
        ...dto,
        periodStart: '2026-10-02T09:00:00.000Z',
        periodEnd: '2026-10-02T10:00:00.001Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.payout.findFirst).not.toHaveBeenCalled();
    expect(tx.payout.create).not.toHaveBeenCalled();
  });

  it('rejects payout while any included lesson is still in its bonus window', async () => {
    tx.lesson.findMany.mockResolvedValue([
      {
        completedAt: new Date('2026-10-02T09:30:00.000Z'),
        teacherRate: new Prisma.Decimal('100'),
        report: null,
      },
    ]);

    await expect(
      service.calculate({
        ...dto,
        periodStart: '2026-10-02T09:00:00.000Z',
        periodEnd: now.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.payout.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(notifier.payoutChanged).not.toHaveBeenCalled();
  });

  it('rejects overlapping periods after locking the teacher', async () => {
    tx.payout.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(service.calculate(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.payout.create).not.toHaveBeenCalled();
  });

  it('rejects an open period in bulk before selecting teachers', async () => {
    await expect(
      service.calculateAll({
        periodStart: now.toISOString(),
        periodEnd: new Date(now.getTime() + 1).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('rolls back the payout path when mandatory audit persistence fails', async () => {
    audit.record.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.calculate(dto)).rejects.toThrow('audit unavailable');

    expect(tx.payout.create).toHaveBeenCalledTimes(1);
    expect(notifier.payoutChanged).not.toHaveBeenCalled();
  });

  it('fails if the teacher profile cannot be locked', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(service.calculate(dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.payout.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an invalid bonus window configuration', () => {
    expect(
      () =>
        new PayoutsService(
          prisma as unknown as PrismaService,
          audit as unknown as AuditService,
          notifier as unknown as TelegramNotifier,
          { get: () => 'NaN' } as never,
        ),
    ).toThrow('BONUS_WINDOW_HOURS must be a non-negative finite number');
  });
});

describe('PayoutsService.markPaid', () => {
  let service: PayoutsService;
  let tx: TxMock;
  let audit: { record: jest.Mock };
  let notifier: { payoutChanged: jest.Mock };
  let prisma: { $transaction: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
    tx = {
      $queryRaw: jest.fn(),
      payout: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      lesson: { findMany: jest.fn() },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifier = { payoutChanged: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      $transaction: jest.fn(
        (callback: (transaction: TxMock) => Promise<unknown>) => callback(tx),
      ),
    };
    service = new PayoutsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
      { get: () => '24' } as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('conditionally marks PENDING as PAID and writes audit/outbox in the same transaction', async () => {
    const payout = {
      id: 'p1',
      status: PayoutStatus.PENDING,
      teacherId: 't1',
      totalPay: new Prisma.Decimal('100.25'),
    };
    const paidAt = new Date('2026-10-02T10:00:00.000Z');
    tx.payout.findUnique
      .mockResolvedValueOnce(payout)
      .mockResolvedValueOnce({ ...payout, status: PayoutStatus.PAID, paidAt });
    tx.payout.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.markPaid('p1');

    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: PayoutStatus.PENDING },
      data: { status: PayoutStatus.PAID, paidAt },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payout.paid' }),
      tx,
    );
    const auditCalls = audit.record.mock.calls as unknown as [
      { details: { totalPay: string } },
      TxMock,
    ][];
    expect(auditCalls[0][0].details.totalPay).toBe('100.25');
    expect(notifier.payoutChanged).toHaveBeenCalledWith('p1', tx);
    expect(result.status).toBe(PayoutStatus.PAID);
  });

  it('returns an existing PAID payout unchanged without duplicate side effects', async () => {
    const paidAt = new Date('2026-09-01T00:00:00.000Z');
    const payout = {
      id: 'p1',
      status: PayoutStatus.PAID,
      paidAt,
      teacherId: 't1',
      totalPay: new Prisma.Decimal('100'),
    };
    tx.payout.findUnique.mockResolvedValue(payout);

    const result = await service.markPaid('p1');

    expect(result).toBe(payout);
    expect(result.paidAt).toBe(paidAt);
    expect(tx.payout.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(notifier.payoutChanged).not.toHaveBeenCalled();
  });

  it('returns the concurrent winner when the conditional transition loses', async () => {
    const pending = {
      id: 'p1',
      status: PayoutStatus.PENDING,
      teacherId: 't1',
      totalPay: new Prisma.Decimal('100'),
    };
    const paid = {
      ...pending,
      status: PayoutStatus.PAID,
      paidAt: new Date('2026-10-02T09:59:00.000Z'),
    };
    tx.payout.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(paid);
    tx.payout.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.markPaid('p1')).resolves.toBe(paid);
    expect(audit.record).not.toHaveBeenCalled();
    expect(notifier.payoutChanged).not.toHaveBeenCalled();
  });

  it('rejects an unknown payout', async () => {
    tx.payout.findUnique.mockResolvedValue(null);

    await expect(service.markPaid('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.payout.updateMany).not.toHaveBeenCalled();
  });
});
