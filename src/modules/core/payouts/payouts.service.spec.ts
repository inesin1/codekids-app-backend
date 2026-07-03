import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PayoutsService } from './payouts.service';

type TxMock = {
  payout: { findFirst: jest.Mock; create: jest.Mock };
  lesson: { findMany: jest.Mock };
};

describe('PayoutsService.calculate', () => {
  let service: PayoutsService;
  let tx: TxMock;
  let prisma: { $transaction: jest.Mock };

  const dto = {
    teacherId: 't1',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
  };

  beforeEach(() => {
    tx = {
      payout: { findFirst: jest.fn(), create: jest.fn() },
      lesson: { findMany: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((cb: (t: TxMock) => unknown) => cb(tx)),
    };
    service = new PayoutsService(
      prisma as unknown as PrismaService,
      { log: jest.fn() } as unknown as AuditService,
    );
  });

  it('должен считать basePay + bonusPay = totalPay', async () => {
    // Arrange
    let payoutData: {
      basePay: Prisma.Decimal;
      bonusPay: Prisma.Decimal;
      totalPay: Prisma.Decimal;
    };
    tx.payout.findFirst.mockResolvedValue(null);
    tx.lesson.findMany.mockResolvedValue([
      {
        teacherRate: new Prisma.Decimal(100),
        report: { bonusApplied: true, bonusAmount: new Prisma.Decimal(50) },
      },
      { teacherRate: new Prisma.Decimal(100), report: null },
    ]);
    tx.payout.create.mockImplementation((args: { data: typeof payoutData }) => {
      payoutData = args.data;
      return args.data;
    });

    // Act
    await service.calculate(dto);

    // Assert
    expect(payoutData!.basePay.toString()).toBe('200');
    expect(payoutData!.bonusPay.toString()).toBe('50');
    expect(payoutData!.totalPay.toString()).toBe('250');
  });

  it('должен использовать полуоткрытый интервал [start, end)', async () => {
    // Arrange
    let where: { completedAt: { gte: Date; lt: Date } };
    tx.payout.findFirst.mockResolvedValue(null);
    tx.lesson.findMany.mockImplementation((args: { where: typeof where }) => {
      where = args.where;
      return [];
    });
    tx.payout.create.mockResolvedValue({});

    // Act
    await service.calculate(dto);

    // Assert
    expect(where!.completedAt).toEqual({
      gte: new Date(dto.periodStart),
      lt: new Date(dto.periodEnd),
    });
  });

  it('должен бросать Conflict при пересечении периода', async () => {
    // Arrange
    tx.payout.findFirst.mockResolvedValue({ id: 'existing' });

    // Act + Assert
    await expect(service.calculate(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.payout.create).not.toHaveBeenCalled();
  });
});
