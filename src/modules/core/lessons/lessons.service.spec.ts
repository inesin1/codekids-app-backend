import { BadRequestException } from '@nestjs/common';
import {
  LessonStatus,
  Prisma,
  TransactionType,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { LessonsService } from './lessons.service';

const scheduledLesson = {
  id: 'l1',
  status: LessonStatus.SCHEDULED,
  teacherId: 't1',
  studentId: 's1',
  enrollmentId: 'e1',
  templateId: null,
  scheduledAt: new Date('2026-10-05T10:00:00.000Z'),
  durationMinutes: 60,
  price: null,
  teacherRate: null,
};

const firstCallArg = <T>(mock: jest.Mock): T => {
  const calls = mock.mock.calls as unknown as Array<[T]>;
  return calls[0][0];
};

describe('LessonsService', () => {
  let service: LessonsService;
  let tx: {
    $queryRaw: jest.Mock;
    lesson: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      createMany: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    enrollment: { findUniqueOrThrow: jest.Mock };
    studentProfile: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    transaction: { create: jest.Mock };
    scheduleTemplate: { findMany: jest.Mock };
    rescheduleRequest: { deleteMany: jest.Mock };
    material: { deleteMany: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    lesson: { findFirst: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let notifier: {
    lessonCanceled: jest.Mock;
    lessonRescheduled: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      lesson: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'l2' }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      enrollment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'e1',
          teacherId: 't1',
          studentId: 's1',
        }),
      },
      studentProfile: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          userId: 's1',
          balance: new Prisma.Decimal(500),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      scheduleTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      rescheduleRequest: { deleteMany: jest.fn() },
      material: { deleteMany: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((callback: (db: typeof tx) => unknown) =>
        callback(tx),
      ),
      lesson: { findFirst: jest.fn() },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifier = {
      lessonCanceled: jest.fn().mockResolvedValue(undefined),
      lessonRescheduled: jest.fn().mockResolvedValue(undefined),
    };
    service = new LessonsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
    );
  });

  describe('complete', () => {
    const arrangeScheduledLesson = (
      lessonPrice: Prisma.Decimal,
      teacherRate: Prisma.Decimal,
    ) => {
      tx.$queryRaw
        .mockResolvedValueOnce([{ userId: 't1' }])
        .mockResolvedValueOnce([{ userId: 's1' }]);
      tx.lesson.findUnique
        .mockResolvedValueOnce({ teacherId: 't1', studentId: 's1' })
        .mockResolvedValueOnce({
          ...scheduledLesson,
          enrollment: { lessonPrice, teacherRate },
        });
      tx.lesson.findUniqueOrThrow.mockResolvedValue({
        ...scheduledLesson,
        status: LessonStatus.COMPLETED,
      });
    };

    it('locks teacher then student, completes conditionally, and charges with Decimal arithmetic', async () => {
      arrangeScheduledLesson(
        new Prisma.Decimal('100.25'),
        new Prisma.Decimal('50.10'),
      );

      await service.complete('l1');

      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[1],
      );
      expect(tx.lesson.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.$queryRaw.mock.invocationCallOrder[1],
      );
      const completion = firstCallArg<{
        where: { id: string; status: LessonStatus };
        data: {
          status: LessonStatus;
          price: Prisma.Decimal;
          teacherRate: Prisma.Decimal;
        };
      }>(tx.lesson.updateMany);
      expect(completion.where).toEqual({
        id: 'l1',
        status: LessonStatus.SCHEDULED,
      });
      expect(completion.data.status).toBe(LessonStatus.COMPLETED);
      expect(completion.data.price.toString()).toBe('100.25');
      expect(completion.data.teacherRate.toString()).toBe('50.1');
      expect(tx.studentProfile.update).toHaveBeenCalledWith({
        where: { userId: 's1' },
        data: { balance: new Prisma.Decimal('399.75') },
      });
      const charge = firstCallArg<{
        data: {
          studentId: string;
          lessonId: string;
          type: TransactionType;
          amount: Prisma.Decimal;
          balanceBefore: Prisma.Decimal;
          balanceAfter: Prisma.Decimal;
        };
      }>(tx.transaction.create).data;
      expect(charge.studentId).toBe('s1');
      expect(charge.lessonId).toBe('l1');
      expect(charge.type).toBe(TransactionType.LESSON_CHARGE);
      expect(charge.amount.toString()).toBe('-100.25');
      expect(charge.balanceBefore.toString()).toBe('500');
      expect(charge.balanceAfter.toString()).toBe('399.75');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'lesson.completed' }),
        tx,
      );
    });

    it('completes a zero-price trial without writing a charge', async () => {
      arrangeScheduledLesson(new Prisma.Decimal(0), new Prisma.Decimal(0));

      await service.complete('l1');

      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      const completion = firstCallArg<{
        data: {
          status: LessonStatus;
          price: Prisma.Decimal;
          teacherRate: Prisma.Decimal;
        };
      }>(tx.lesson.updateMany);
      expect(completion.data.status).toBe(LessonStatus.COMPLETED);
      expect(completion.data.price.toString()).toBe('0');
      expect(completion.data.teacherRate.toString()).toBe('0');
      expect(tx.studentProfile.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });

    it('rejects a lesson whose scheduled transition lost a race', async () => {
      arrangeScheduledLesson(new Prisma.Decimal(100), new Prisma.Decimal(50));
      tx.lesson.updateMany.mockResolvedValue({ count: 0 });
      tx.lesson.findUnique.mockResolvedValueOnce({
        status: LessonStatus.COMPLETED,
      });

      await expect(service.complete('l1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.studentProfile.update).not.toHaveBeenCalled();
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });
  });

  it('derives lesson participants from its active enrollment and rejects mismatches', async () => {
    tx.$queryRaw.mockReset().mockResolvedValue([{ id: 'e1' }]);
    tx.enrollment.findUniqueOrThrow.mockResolvedValue({
      id: 'e1',
      teacherId: 't1',
      studentId: 's1',
    });

    await expect(
      service.create({
        enrollmentId: 'e1',
        teacherId: 'other-teacher',
        studentId: 's1',
        scheduledAt: '2026-10-05T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.lesson.create).not.toHaveBeenCalled();
  });

  it('does not generate lessons for enrollments that became inactive', async () => {
    tx.scheduleTemplate.findMany.mockResolvedValue([
      {
        id: 'template-active',
        enrollmentId: 'e1',
        teacherId: 't1',
        studentId: 's1',
        timezone: 'UTC',
        slots: [
          {
            dayOfWeek: 'MONDAY',
            startTime: '10:00',
            durationMinutes: 60,
          },
        ],
      },
      {
        id: 'template-inactive',
        enrollmentId: 'e2',
        teacherId: 't2',
        studentId: 's2',
        timezone: 'UTC',
        slots: [
          {
            dayOfWeek: 'MONDAY',
            startTime: '11:00',
            durationMinutes: 60,
          },
        ],
      },
    ]);
    tx.$queryRaw.mockResolvedValue([{ id: 'e1' }]);

    await service.generate({
      dateFrom: '2026-10-05T00:00:00.000Z',
      dateTo: '2026-10-05T23:59:59.999Z',
    });

    const templateQuery = firstCallArg<{
      where: { isActive: boolean; enrollment: { is: { isActive: boolean } } };
    }>(tx.scheduleTemplate.findMany);
    expect(templateQuery.where).toEqual({
      isActive: true,
      enrollment: { is: { isActive: true } },
    });
    expect(tx.lesson.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ enrollmentId: 'e1', studentId: 's1' })],
      skipDuplicates: true,
    });
  });

  it('returns the student’s next and latest completed lessons without internal notes', async () => {
    const nextLesson = {
      ...scheduledLesson,
      report: { extraNotes: 'staff only' },
    };
    const latestCompletedLesson = {
      ...scheduledLesson,
      id: 'old-lesson',
      status: LessonStatus.COMPLETED,
      scheduledAt: new Date('2020-01-01T10:00:00.000Z'),
      report: { extraNotes: 'staff only' },
    };
    prisma.lesson.findFirst
      .mockResolvedValueOnce(nextLesson)
      .mockResolvedValueOnce(latestCompletedLesson);

    const result = await service.findStudentHome('student-1');

    expect(result.nextLesson?.id).toBe('l1');
    expect(result.latestCompletedLesson?.id).toBe('old-lesson');
    expect(result.nextLesson?.report?.extraNotes).toBeNull();
    expect(result.latestCompletedLesson?.report?.extraNotes).toBeNull();
    const queries = prisma.lesson.findFirst.mock.calls.map(([query]) => query);
    expect(queries[0].where).toEqual({
      studentId: 'student-1',
      status: LessonStatus.SCHEDULED,
      scheduledAt: { gte: expect.any(Date) },
    });
    expect(queries[1].where).toEqual({
      studentId: 'student-1',
      status: LessonStatus.COMPLETED,
    });
    expect(queries[1].orderBy[0]).toEqual({ scheduledAt: 'desc' });
  });

  it('returns null home lessons when the student has no matching records', async () => {
    prisma.lesson.findFirst.mockResolvedValue(null);

    await expect(service.findStudentHome('student-1')).resolves.toEqual({
      nextLesson: null,
      latestCompletedLesson: null,
    });
  });

  it('copies zero-valued financial snapshots to a rescheduled lesson', async () => {
    tx.lesson.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.lesson.findUnique.mockResolvedValue({
      ...scheduledLesson,
      meetingUrlOverride: 'https://meet.example.com/lesson',
      price: new Prisma.Decimal(0),
      teacherRate: new Prisma.Decimal(0),
    });
    tx.lesson.findUniqueOrThrow.mockResolvedValue({
      ...scheduledLesson,
      status: LessonStatus.RESCHEDULED,
      rescheduledToId: 'l2',
    });

    await service.reschedule('l1', {
      newDate: '2026-10-06T10:00:00.000Z',
    });

    const newLesson = firstCallArg<{
      data: {
        price: Prisma.Decimal;
        teacherRate: Prisma.Decimal;
        meetingUrlOverride: string;
      };
    }>(tx.lesson.create).data;
    expect(newLesson.price.toString()).toBe('0');
    expect(newLesson.teacherRate.toString()).toBe('0');
    expect(newLesson.meetingUrlOverride).toBe(
      'https://meet.example.com/lesson',
    );
    expect(notifier.lessonRescheduled).toHaveBeenCalledWith(
      'l1',
      scheduledLesson.scheduledAt,
      tx,
    );
  });

  it('refuses updates after completion', async () => {
    tx.lesson.updateMany.mockResolvedValue({ count: 0 });
    tx.lesson.findUnique.mockResolvedValue({ status: LessonStatus.COMPLETED });

    await expect(service.update('l1', { price: 25 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('stores lesson link overrides without writing their value to the audit log', async () => {
    const meetingUrlOverride = 'https://meet.example.com/lesson';
    tx.lesson.findUniqueOrThrow.mockResolvedValue(scheduledLesson);

    await service.update('l1', { meetingUrlOverride });

    expect(tx.lesson.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'l1', status: LessonStatus.SCHEDULED },
        data: { meetingUrlOverride },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain(
      meetingUrlOverride,
    );
    expect(audit.record.mock.calls[0][0].details).toEqual({
      meetingUrlOverrideChanged: true,
    });
  });
});
