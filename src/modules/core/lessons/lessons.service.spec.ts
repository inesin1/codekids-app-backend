import { BadRequestException } from '@nestjs/common';
import { LessonStatus, Prisma } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';

describe('LessonsService.complete', () => {
  let service: LessonsService;
  let prisma: {
    lesson: { findUnique: jest.Mock; update: jest.Mock };
    enrollment: { findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    studentProfile: { findUniqueOrThrow: jest.Mock };
    parentProfile: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    transaction: { create: jest.Mock };
    lesson: { update: jest.Mock };
  };

  const scheduledLesson = {
    id: 'l1',
    status: LessonStatus.SCHEDULED,
    studentId: 's1',
    enrollmentId: 'e1',
    price: null,
    teacherRate: null,
  };

  beforeEach(() => {
    tx = {
      studentProfile: { findUniqueOrThrow: jest.fn() },
      parentProfile: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
      transaction: { create: jest.fn() },
      lesson: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      lesson: {
        findUnique: jest.fn().mockResolvedValue(scheduledLesson),
        update: jest.fn().mockResolvedValue({}),
      },
      enrollment: { findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    service = new LessonsService(prisma as unknown as PrismaService);
  });

  it('должен списывать с родителя при платном уроке (price > 0)', async () => {
    // Arrange
    let charge: { amount: Prisma.Decimal; balanceAfter: Prisma.Decimal };
    prisma.enrollment.findUniqueOrThrow.mockResolvedValue({
      lessonPrice: new Prisma.Decimal(100),
      teacherRate: new Prisma.Decimal(50),
    });
    tx.studentProfile.findUniqueOrThrow.mockResolvedValue({
      id: 's1',
      parentId: 'p1',
    });
    tx.parentProfile.findUniqueOrThrow.mockResolvedValue({
      id: 'p1',
      balance: new Prisma.Decimal(500),
    });
    tx.transaction.create.mockImplementation(
      (args: { data: typeof charge }) => {
        charge = args.data;
        return {};
      },
    );

    // Act
    await service.complete('l1');

    // Assert
    expect(charge!.amount.toString()).toBe('-100');
    expect(charge!.balanceAfter.toString()).toBe('400');
  });

  it('должен пропускать списание для пробного урока (price = 0)', async () => {
    // Arrange
    prisma.enrollment.findUniqueOrThrow.mockResolvedValue({
      lessonPrice: new Prisma.Decimal(0),
      teacherRate: new Prisma.Decimal(0),
    });

    // Act
    await service.complete('l1');

    // Assert
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.lesson.update).toHaveBeenCalled();
  });

  it('должен запрещать платный урок без родителя', async () => {
    // Arrange
    prisma.enrollment.findUniqueOrThrow.mockResolvedValue({
      lessonPrice: new Prisma.Decimal(100),
      teacherRate: new Prisma.Decimal(50),
    });
    tx.studentProfile.findUniqueOrThrow.mockResolvedValue({
      id: 's1',
      parentId: null,
    });

    // Act + Assert
    await expect(service.complete('l1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
