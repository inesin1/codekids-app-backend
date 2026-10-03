import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { TransactionType } from '../../src/generated/client';
import { AuditService } from '../../src/modules/common/audit/audit.service';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/core/payments/payments.service';

describe('student payments with PostgreSQL', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let payments: PaymentsService;
  let studentId: string;

  beforeAll(async () => {
    prisma = new PrismaService({
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return process.env['DATABASE_URL'];
        throw new Error(`Unexpected config key: ${key}`);
      },
    } as ConfigService);
    await prisma.$connect();
    audit = new AuditService(prisma, {
      isActive: () => false,
    } as unknown as ClsService);
    payments = new PaymentsService(prisma, audit);
  });

  beforeEach(async () => {
    studentId = `integration-payment-student-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: studentId,
        firstName: 'Integration',
        lastName: 'Student',
        studentProfile: { create: { balance: '5.00' } },
      },
    });
  });

  afterEach(async () => {
    const paymentIds = await prisma.payment.findMany({
      where: { studentId },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: paymentIds.map(({ id }) => id) } },
    });
    await prisma.transaction.deleteMany({ where: { studentId } });
    await prisma.payment.deleteMany({ where: { studentId } });
    await prisma.user.delete({ where: { id: studentId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serializes concurrent top-ups and keeps every ledger entry balanced', async () => {
    await Promise.all([
      payments.create(studentId, { amount: '10.01' }),
      payments.create(studentId, { amount: '5.02' }),
    ]);

    const student = await prisma.studentProfile.findUniqueOrThrow({
      where: { userId: studentId },
      select: { balance: true },
    });
    const [paymentRows, ledgerRows] = await Promise.all([
      prisma.payment.findMany({ where: { studentId } }),
      prisma.transaction.findMany({
        where: { studentId, type: TransactionType.MANUAL_TOPUP },
      }),
    ]);
    const auditCount = await prisma.auditLog.count({
      where: {
        entityId: { in: paymentRows.map(({ id }) => id) },
        entityType: 'Payment',
        action: 'payment.created',
      },
    });

    expect(student.balance.toString()).toBe('20.03');
    expect(paymentRows.map((row) => row.amount.toString()).sort()).toEqual([
      '10.01',
      '5.02',
    ]);
    expect(ledgerRows).toHaveLength(2);
    for (const row of ledgerRows) {
      expect(row.balanceBefore.add(row.amount).toString()).toBe(
        row.balanceAfter.toString(),
      );
    }
    expect(ledgerRows.some((row) => row.balanceBefore.toString() === '5')).toBe(
      true,
    );
    expect(
      ledgerRows.some((row) => row.balanceAfter.toString() === '20.03'),
    ).toBe(true);
    expect(auditCount).toBe(2);
  });

  it('rolls back the payment and balance when the mandatory audit fails', async () => {
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      payments.create(studentId, { amount: '10.00' }),
    ).rejects.toThrow('audit unavailable');

    const [student, paymentCount, ledgerCount] = await Promise.all([
      prisma.studentProfile.findUniqueOrThrow({
        where: { userId: studentId },
        select: { balance: true },
      }),
      prisma.payment.count({ where: { studentId } }),
      prisma.transaction.count({ where: { studentId } }),
    ]);
    expect(student.balance.toString()).toBe('5');
    expect(paymentCount).toBe(0);
    expect(ledgerCount).toBe(0);
  });
});
