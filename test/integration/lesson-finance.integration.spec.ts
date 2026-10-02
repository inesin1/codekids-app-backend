import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { DayOfWeek, LessonStatus } from '../../src/generated/client';
import { AuditService } from '../../src/modules/common/audit/audit.service';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { TelegramNotifier } from '../../src/modules/common/telegram/telegram.notifier';
import { LessonsService } from '../../src/modules/core/lessons/lessons.service';
import { ReportsService } from '../../src/modules/core/lessons/reports.service';
import { PayoutsService } from '../../src/modules/core/payouts/payouts.service';

describe('Lesson transitions, balances and payouts with PostgreSQL', () => {
  let prisma: PrismaService;
  let service: LessonsService;
  let audit: AuditService;
  let studentId: string;
  let teacherIds: string[];
  let courseId: string;
  let enrollmentIds: string[];
  const notifier = {
    lessonCanceled: jest.fn().mockResolvedValue(undefined),
    lessonRescheduled: jest.fn().mockResolvedValue(undefined),
    payoutChanged: jest.fn().mockResolvedValue(undefined),
    queueReport: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    prisma = new PrismaService({
      getOrThrow: () => process.env['DATABASE_URL'],
    } as unknown as ConfigService);
    await prisma.$connect();
    audit = new AuditService(prisma, {
      isActive: () => false,
    } as unknown as ClsService);
    service = new LessonsService(
      prisma,
      audit,
      notifier as unknown as TelegramNotifier,
    );
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    studentId = randomUUID();
    teacherIds = [randomUUID(), randomUUID()];
    await prisma.user.create({
      data: {
        id: studentId,
        firstName: 'Fixture',
        lastName: 'Student',
        studentProfile: { create: { balance: '1000.00' } },
      },
    });
    for (const id of teacherIds) {
      await prisma.user.create({
        data: {
          id,
          firstName: 'Fixture',
          lastName: 'Teacher',
          teacherProfile: { create: {} },
        },
      });
    }
    const course = await prisma.course.create({
      data: { name: `Fixture-${randomUUID()}` },
    });
    courseId = course.id;
    enrollmentIds = [];
    for (const teacherId of teacherIds) {
      const enrollment = await prisma.enrollment.create({
        data: {
          courseId,
          teacherId,
          studentId,
          lessonPrice: '100.25',
          teacherRate: '50.10',
        },
      });
      enrollmentIds.push(enrollment.id);
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const reportRows = await prisma.lessonReport.findMany({
      where: { lesson: { studentId } },
      select: { id: true },
    });
    const payoutRows = await prisma.payout.findMany({
      where: { teacherId: { in: teacherIds } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityId: {
          in: (
            await prisma.lesson.findMany({
              where: { studentId },
              select: { id: true },
            })
          ).map((row) => row.id),
        },
      },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityId: { in: [...reportRows, ...payoutRows].map((row) => row.id) },
      },
    });
    await prisma.transaction.deleteMany({ where: { studentId } });
    await prisma.payout.deleteMany({
      where: { teacherId: { in: teacherIds } },
    });
    await prisma.lesson.updateMany({
      where: { studentId },
      data: { rescheduledToId: null },
    });
    await prisma.lesson.deleteMany({ where: { studentId } });
    await prisma.scheduleTemplate.deleteMany({ where: { studentId } });
    await prisma.enrollment.deleteMany({ where: { studentId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.user.deleteMany({
      where: { id: { in: [studentId, ...teacherIds] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function lesson(index = 0, price?: string) {
    return prisma.lesson.create({
      data: {
        enrollmentId: enrollmentIds[index],
        teacherId: teacherIds[index],
        studentId,
        scheduledAt: new Date(),
        ...(price !== undefined && { price, teacherRate: '17.35' }),
      },
    });
  }

  function config(hours = '24') {
    return {
      get: (key: string) => (key === 'BONUS_AMOUNT' ? '12.35' : hours),
    } as unknown as ConfigService;
  }

  function payouts(hours = '24') {
    return new PayoutsService(
      prisma,
      audit,
      notifier as unknown as TelegramNotifier,
      config(hours),
    );
  }

  function reports(hours = '24') {
    return new ReportsService(
      prisma,
      audit,
      notifier as unknown as TelegramNotifier,
      config(hours),
    );
  }

  async function completedLesson(
    index = 0,
    completedAt = new Date('2020-01-05T12:00:00Z'),
  ) {
    const row = await lesson(index);
    return prisma.lesson.update({
      where: { id: row.id },
      data: {
        status: LessonStatus.COMPLETED,
        completedAt,
        price: '100.25',
        teacherRate: '50.10',
      },
    });
  }

  const historicalPeriod = {
    periodStart: '2020-01-01T00:00:00Z',
    periodEnd: '2020-02-01T00:00:00Z',
  };

  it('allows one overlapping payout and permits an adjacent half-open period', async () => {
    await completedLesson();
    const payoutService = payouts();
    const results = await Promise.allSettled([
      payoutService.calculate({
        teacherId: teacherIds[0],
        ...historicalPeriod,
      }),
      payoutService.calculate({
        teacherId: teacherIds[0],
        periodStart: '2020-01-02T00:00:00Z',
        periodEnd: '2020-02-02T00:00:00Z',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const saved = await prisma.payout.findFirstOrThrow({
      where: { teacherId: teacherIds[0] },
    });
    expect(saved.totalPay.toFixed(2)).toBe('50.10');
    await payoutService.calculate({
      teacherId: teacherIds[0],
      periodStart: saved.periodEnd.toISOString(),
      periodEnd: '2020-03-01T00:00:00Z',
    });
    expect(
      await prisma.payout.count({ where: { teacherId: teacherIds[0] } }),
    ).toBe(2);
  });

  it('changes PAID only once for concurrent requests and retains paidAt on retries', async () => {
    await completedLesson();
    const payoutService = payouts();
    const saved = await payoutService.calculate({
      teacherId: teacherIds[0],
      ...historicalPeriod,
    });
    notifier.payoutChanged.mockClear();
    const results = await Promise.all([
      payoutService.markPaid(saved.id),
      payoutService.markPaid(saved.id),
    ]);
    expect(results[0].paidAt).toEqual(results[1].paidAt);
    const retried = await payoutService.markPaid(saved.id);
    expect(retried.paidAt).toEqual(results[0].paidAt);
    expect(notifier.payoutChanged).toHaveBeenCalledTimes(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: saved.id, action: 'payout.paid' },
      }),
    ).toBe(1);
  });

  it('rejects calculation until the included lesson bonus window has closed', async () => {
    const completedAt = new Date(Date.now() - 60_000);
    await completedLesson(0, completedAt);
    await expect(
      payouts().calculate({
        teacherId: teacherIds[0],
        periodStart: new Date(completedAt.getTime() - 1_000).toISOString(),
        periodEnd: new Date(completedAt.getTime() + 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.payout.count({ where: { teacherId: teacherIds[0] } }),
    ).toBe(0);
  });

  it('includes a timely submitted Decimal bonus in the finalized payout', async () => {
    const row = await completedLesson(0, new Date(Date.now() - 60_000));
    const reportService = reports();
    await reportService.create(row.id, {
      topic: 'Fixture',
      covered: 'Fixture',
      results: 'Fixture',
    });
    const submitted = await reportService.submit(row.id);
    expect(submitted.bonusAmount?.toFixed(2)).toBe('12.35');
    await reportService.submit(row.id);
    expect(notifier.queueReport).toHaveBeenCalledTimes(1);
    // Move fixture time beyond the window before testing the final calculation.
    await prisma.lesson.update({
      where: { id: row.id },
      data: { completedAt: new Date('2020-01-05T12:00:00Z') },
    });
    const saved = await payouts().calculate({
      teacherId: teacherIds[0],
      ...historicalPeriod,
    });
    expect(saved.basePay.toFixed(2)).toBe('50.10');
    expect(saved.bonusPay.toFixed(2)).toBe('12.35');
    expect(saved.totalPay.toFixed(2)).toBe('62.45');
  });

  it('does not reopen a finalized payout when the configured bonus window grows', async () => {
    const completedAt = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const row = await completedLesson(0, completedAt);
    await reports().create(row.id, {
      topic: 'Fixture',
      covered: 'Fixture',
      results: 'Fixture',
    });
    const saved = await payouts().calculate({
      teacherId: teacherIds[0],
      periodStart: new Date(completedAt.getTime() - 1_000).toISOString(),
      periodEnd: new Date(completedAt.getTime() + 1_000).toISOString(),
    });
    const submitted = await reports('48').submit(row.id);
    expect(submitted.bonusApplied).toBe(false);
    expect(submitted.bonusAmount).toBeNull();
    expect(
      (
        await prisma.payout.findUniqueOrThrow({ where: { id: saved.id } })
      ).totalPay.toFixed(2),
    ).toBe('50.10');
  });

  it('rolls back a payout when mandatory delivery persistence fails', async () => {
    await completedLesson();
    notifier.payoutChanged.mockRejectedValueOnce(
      new Error('synthetic payout outbox failure'),
    );
    await expect(
      payouts().calculate({ teacherId: teacherIds[0], ...historicalPeriod }),
    ).rejects.toThrow('synthetic payout outbox failure');
    expect(
      await prisma.payout.count({ where: { teacherId: teacherIds[0] } }),
    ).toBe(0);
  });

  it('retries a partially failed bulk calculation without duplicating successful payouts', async () => {
    await completedLesson(0);
    await completedLesson(1);
    notifier.payoutChanged
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic partial failure'));
    const payoutService = payouts();
    await expect(payoutService.calculateAll(historicalPeriod)).rejects.toThrow(
      'synthetic partial failure',
    );
    expect(
      await prisma.payout.count({ where: { teacherId: { in: teacherIds } } }),
    ).toBe(1);
    const retried = await payoutService.calculateAll(historicalPeriod);
    expect(retried.created).toHaveLength(1);
    expect(retried.skipped).toHaveLength(1);
    expect(
      await prisma.payout.count({ where: { teacherId: { in: teacherIds } } }),
    ).toBe(2);
  });

  it('serializes two different teachers charging the same student without losing either balance change', async () => {
    const lessons = [await lesson(0), await lesson(1)];
    await Promise.all(lessons.map((row) => service.complete(row.id)));
    const student = await prisma.studentProfile.findUniqueOrThrow({
      where: { userId: studentId },
    });
    expect(student.balance.toFixed(2)).toBe('799.50');
    const charges = await prisma.transaction.findMany({ where: { studentId } });
    expect(charges).toHaveLength(2);
    expect(
      charges
        .map(
          (row) =>
            `${row.balanceBefore.toFixed(2)}>${row.balanceAfter.toFixed(2)}`,
        )
        .sort(),
    ).toEqual(['1000.00>899.75', '899.75>799.50']);
    expect(charges.map((row) => row.amount.toFixed(2))).toEqual([
      '-100.25',
      '-100.25',
    ]);
  });

  it('allows one terminal transition when completion competes with cancellation', async () => {
    const row = await lesson();
    const results = await Promise.allSettled([
      service.complete(row.id),
      service.cancel(row.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const persisted = await prisma.lesson.findUniqueOrThrow({
      where: { id: row.id },
    });
    const completed = persisted.status === LessonStatus.COMPLETED;
    expect([LessonStatus.COMPLETED, LessonStatus.CANCELED]).toContain(
      persisted.status,
    );
    expect(
      await prisma.transaction.count({ where: { lessonId: row.id } }),
    ).toBe(completed ? 1 : 0);
    expect(
      (
        await prisma.studentProfile.findUniqueOrThrow({
          where: { userId: studentId },
        })
      ).balance.toFixed(2),
    ).toBe(completed ? '899.75' : '1000.00');
  });

  it('reschedules a trial only once and retains zero price and its individual teacher rate', async () => {
    const row = await lesson(0, '0.00');
    const results = await Promise.allSettled([
      service.reschedule(row.id, { newDate: '2026-10-05T12:00:00Z' }),
      service.reschedule(row.id, { newDate: '2026-10-06T12:00:00Z' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await prisma.lesson.count({ where: { studentId } })).toBe(2);
    const original = await prisma.lesson.findUniqueOrThrow({
      where: { id: row.id },
      include: { rescheduledTo: true },
    });
    expect(original.status).toBe(LessonStatus.RESCHEDULED);
    expect(original.rescheduledTo?.price?.toFixed(2)).toBe('0.00');
    expect(original.rescheduledTo?.teacherRate?.toFixed(2)).toBe('17.35');
    await service.complete(original.rescheduledToId!);
    expect(await prisma.transaction.count({ where: { studentId } })).toBe(0);
    expect(
      (
        await prisma.studentProfile.findUniqueOrThrow({
          where: { userId: studentId },
        })
      ).balance.toFixed(2),
    ).toBe('1000.00');
  });

  it('rolls back completion and its charge when mandatory audit fails', async () => {
    const row = await lesson();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    await expect(service.complete(row.id)).rejects.toThrow(
      'synthetic audit failure',
    );
    expect(
      (await prisma.lesson.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe(LessonStatus.SCHEDULED);
    expect(await prisma.transaction.count({ where: { studentId } })).toBe(0);
    expect(
      (
        await prisma.studentProfile.findUniqueOrThrow({
          where: { userId: studentId },
        })
      ).balance.toFixed(2),
    ).toBe('1000.00');
  });

  it('rolls back cancellation when mandatory outbox persistence fails', async () => {
    const row = await lesson();
    notifier.lessonCanceled.mockRejectedValueOnce(
      new Error('synthetic outbox failure'),
    );
    await expect(service.cancel(row.id)).rejects.toThrow(
      'synthetic outbox failure',
    );
    expect(
      (await prisma.lesson.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe(LessonStatus.SCHEDULED);
    expect(await prisma.auditLog.count({ where: { entityId: row.id } })).toBe(
      0,
    );
  });

  it('rejects contradictory enrollment participants in both service and database writes', async () => {
    await expect(
      service.create({
        enrollmentId: enrollmentIds[0],
        teacherId: teacherIds[1],
        scheduledAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      prisma.lesson.create({
        data: {
          enrollmentId: enrollmentIds[0],
          teacherId: teacherIds[1],
          studentId,
          scheduledAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.scheduleTemplate.create({
        data: {
          enrollmentId: enrollmentIds[0],
          teacherId: teacherIds[1],
          studentId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('keeps completed financial snapshots immutable and rejects a second charge', async () => {
    const row = await lesson(0, '123.45');
    await service.complete(row.id);
    await expect(
      service.update(row.id, { price: 0, teacherRate: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.complete(row.id)).rejects.toMatchObject({
      status: 400,
    });
    const persisted = await prisma.lesson.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(persisted.price?.toFixed(2)).toBe('123.45');
    expect(persisted.teacherRate?.toFixed(2)).toBe('17.35');
    expect(
      await prisma.transaction.count({ where: { lessonId: row.id } }),
    ).toBe(1);
  });

  it('keeps the charged amount consistent with the snapshot when update races completion', async () => {
    const row = await lesson();
    const [completion] = await Promise.allSettled([
      service.complete(row.id),
      service.update(row.id, { price: 222.22, teacherRate: 111.11 }),
    ]);
    expect(completion.status).toBe('fulfilled');
    const saved = await prisma.lesson.findUniqueOrThrow({
      where: { id: row.id },
    });
    const charge = await prisma.transaction.findUniqueOrThrow({
      where: { lessonId: row.id },
    });
    expect(['100.25', '222.22']).toContain(saved.price?.toFixed(2));
    expect(charge.amount.toFixed(2)).toBe(saved.price!.negated().toFixed(2));
    expect(charge.balanceAfter.toFixed(2)).toBe(
      charge.balanceBefore.sub(saved.price!).toFixed(2),
    );
    expect(saved.teacherRate?.toFixed(2)).toBe(
      saved.price?.toFixed(2) === '222.22' ? '111.11' : '50.10',
    );
  });

  it('does not generate from an inactive enrollment or remove previously scheduled lessons', async () => {
    const existing = await lesson();
    const template = await prisma.scheduleTemplate.create({
      data: {
        enrollmentId: enrollmentIds[0],
        teacherId: teacherIds[0],
        studentId,
        slots: { create: { dayOfWeek: DayOfWeek.MONDAY, startTime: '12:00' } },
      },
    });
    await prisma.enrollment.update({
      where: { id: enrollmentIds[0] },
      data: { isActive: false },
    });
    await service.generate({
      dateFrom: '2026-10-05T00:00:00Z',
      dateTo: '2026-10-06T00:00:00Z',
      templateIds: [template.id],
    });
    expect(await prisma.lesson.count({ where: { studentId } })).toBe(1);
    expect(
      (await prisma.lesson.findUniqueOrThrow({ where: { id: existing.id } }))
        .status,
    ).toBe(LessonStatus.SCHEDULED);
  });
});
