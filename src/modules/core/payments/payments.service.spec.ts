import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from './payments.service';

describe('PaymentsService.create', () => {
  const tx = {
    $queryRaw: jest.fn(),
    studentProfile: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn() },
    transaction: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const audit = { record: jest.fn() };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ userId: 'student-1' }]);
    tx.studentProfile.findUniqueOrThrow.mockResolvedValue({
      balance: new Prisma.Decimal('5.00'),
    });
    tx.payment.create.mockResolvedValue({ id: 'payment-1', amount: '10.25' });
    tx.studentProfile.update.mockResolvedValue(undefined);
    tx.transaction.create.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
  });

  it('locks the student and records exact balance, payment, transaction, and audit values', async () => {
    await service.create('student-1', {
      amount: '10.25',
      description: '  cash receipt  ',
    });

    expect(tx.studentProfile.update).toHaveBeenCalledWith({
      where: { userId: 'student-1' },
      data: { balance: new Prisma.Decimal('15.25') },
    });
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: {
        studentId: 'student-1',
        amount: new Prisma.Decimal('10.25'),
        description: 'cash receipt',
      },
    });
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: {
        studentId: 'student-1',
        type: 'MANUAL_TOPUP',
        amount: new Prisma.Decimal('10.25'),
        balanceBefore: new Prisma.Decimal('5.00'),
        balanceAfter: new Prisma.Decimal('15.25'),
        description: 'cash receipt',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.created',
        entityType: 'Payment',
        entityId: 'payment-1',
        details: {
          studentId: 'student-1',
          amount: '10.25',
          balanceAfter: '15.25',
        },
      }),
      tx,
    );
  });

  it.each(['0', '-1', 'abc', '1.001', '10000000000'])(
    'rejects invalid amount %s',
    async (amount) => {
      await expect(
        service.create('student-1', { amount }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects a top-up that exceeds the balance column range', async () => {
    tx.studentProfile.findUniqueOrThrow.mockResolvedValueOnce({
      balance: new Prisma.Decimal('9999999999.99'),
    });

    await expect(
      service.create('student-1', { amount: '0.01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.studentProfile.update).not.toHaveBeenCalled();
  });

  it('rejects a user without a student profile', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.create('not-a-student', { amount: '1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('lets an audit failure abort the transaction callback', async () => {
    audit.record.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.create('student-1', { amount: '1' })).rejects.toThrow(
      'audit unavailable',
    );
  });
});
