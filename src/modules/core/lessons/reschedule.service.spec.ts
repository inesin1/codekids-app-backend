import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  LessonStatus,
  RescheduleRequestStatus,
  RescheduleRequestType,
  Role,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { TelegramService } from '../../common/telegram/telegram.service';
import { LessonsService } from './lessons.service';
import { RescheduleService } from './reschedule.service';

const TEACHER = { id: 'teacher', roles: [Role.TEACHER] };
const STUDENT = { id: 'student', roles: [Role.STUDENT] };
const OTHER_STUDENT = { id: 'other-student', roles: [Role.STUDENT] };
const MANAGER = { id: 'manager', roles: [Role.MANAGER] };

const makeRequest = (createdById: string) => ({
  id: 'rr1',
  lessonId: 'l1',
  type: RescheduleRequestType.CANCEL,
  status: RescheduleRequestStatus.PENDING,
  proposedDate: null,
  createdById,
  lesson: {
    id: 'l1',
    teacherId: TEACHER.id,
    scheduledAt: new Date('2026-09-20T13:00:00Z'),
    student: { userId: STUDENT.id },
  },
});

const resolveTelegramActor = (
  service: RescheduleService,
  telegramUserId: number,
  requestId: string,
) => {
  const resolver = service as unknown as {
    findTelegramActor: (
      telegramUserId: number,
      requestId: string,
    ) => Promise<{ id: string; roles: Role[] } | null>;
  };
  return resolver.findTelegramActor(telegramUserId, requestId);
};

describe('RescheduleService.approve', () => {
  let service: RescheduleService;
  let audit: { record: jest.Mock };
  let prisma: {
    lesson: { findUnique: jest.Mock };
    rescheduleRequest: { findUnique: jest.Mock; findMany: jest.Mock };
    user: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    lesson: { findUnique: jest.Mock; updateMany: jest.Mock };
    rescheduleRequest: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let lessonsService: { cancelWithin: jest.Mock; rescheduleWithin: jest.Mock };

  beforeEach(() => {
    tx = {
      lesson: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rescheduleRequest: {
        create: jest.fn().mockResolvedValue(makeRequest(TEACHER.id)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      lesson: { findUnique: jest.fn() },
      rescheduleRequest: { findUnique: jest.fn(), findMany: jest.fn() },
      user: { findMany: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    lessonsService = { cancelWithin: jest.fn(), rescheduleWithin: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RescheduleService(
      prisma as unknown as PrismaService,
      lessonsService as unknown as LessonsService,
      audit as unknown as AuditService,
      {} as TelegramService,
      {
        rescheduleRequestChanged: jest.fn(),
        lessonCanceled: jest.fn(),
        lessonRescheduled: jest.fn(),
      } as unknown as TelegramNotifier,
    );
  });

  it.each([
    ['заявку преподавателя — ученик', TEACHER.id, STUDENT],
    ['заявку ученика — преподаватель', STUDENT.id, TEACHER],
    ['любую заявку — менеджер', TEACHER.id, MANAGER],
  ])('должен разрешать подтверждать %s', async (_, createdById, actor) => {
    // Arrange
    prisma.rescheduleRequest.findUnique.mockResolvedValue(
      makeRequest(createdById),
    );

    // Act
    await service.approve('rr1', actor);

    // Assert
    expect(lessonsService.cancelWithin).toHaveBeenCalledWith(tx, 'l1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lesson.canceled' }),
      tx,
    );
  });

  it.each([
    ['преподавателю свою заявку', TEACHER.id, TEACHER],
    ['ученику свою заявку', STUDENT.id, STUDENT],
    ['чужому ученику', TEACHER.id, OTHER_STUDENT],
  ])('должен запрещать подтверждать %s', async (_, createdById, actor) => {
    // Arrange
    prisma.rescheduleRequest.findUnique.mockResolvedValue(
      makeRequest(createdById),
    );

    // Act
    const act = service.approve('rr1', actor);

    // Assert
    await expect(act).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('не должен менять урок, если заявку уже решили параллельно', async () => {
    // Arrange
    prisma.rescheduleRequest.findUnique.mockResolvedValue(
      makeRequest(TEACHER.id),
    );
    tx.rescheduleRequest.updateMany.mockResolvedValue({ count: 0 });

    // Act
    const act = service.approve('rr1', STUDENT);

    // Assert
    await expect(act).rejects.toThrow(BadRequestException);
    expect(lessonsService.cancelWithin).not.toHaveBeenCalled();
  });

  it('checks lesson ownership before exposing that a lesson is completed', async () => {
    tx.lesson.findUnique.mockResolvedValue({
      status: LessonStatus.COMPLETED,
      teacherId: TEACHER.id,
      studentId: STUDENT.id,
    });

    await expect(
      service.createRequest('l1', OTHER_STUDENT, {
        type: RescheduleRequestType.CANCEL,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.lesson.updateMany).not.toHaveBeenCalled();
    expect(tx.rescheduleRequest.create).not.toHaveBeenCalled();
  });

  it('chooses the student linked to the request when a Telegram ID is shared', async () => {
    prisma.rescheduleRequest.findUnique.mockResolvedValue({
      createdById: TEACHER.id,
      lesson: { teacherId: TEACHER.id, studentId: STUDENT.id },
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: OTHER_STUDENT.id,
        staffRoles: [],
        teacherProfile: null,
        studentProfile: { userId: OTHER_STUDENT.id },
      },
      {
        id: STUDENT.id,
        staffRoles: [],
        teacherProfile: null,
        studentProfile: { userId: STUDENT.id },
      },
    ]);

    const actor = await resolveTelegramActor(service, 100, 'rr1');

    expect(actor).toEqual(STUDENT);
  });

  it('does not let a teacher approve their own request through a linked student account', async () => {
    prisma.rescheduleRequest.findUnique.mockResolvedValue({
      createdById: TEACHER.id,
      lesson: { teacherId: TEACHER.id, studentId: STUDENT.id },
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: TEACHER.id,
        staffRoles: [],
        teacherProfile: { userId: TEACHER.id },
        studentProfile: null,
      },
      {
        id: STUDENT.id,
        staffRoles: [],
        teacherProfile: null,
        studentProfile: { userId: STUDENT.id },
      },
    ]);

    await expect(resolveTelegramActor(service, 100, 'rr1')).resolves.toBeNull();
  });

  it('prefers current staff authority before rejecting a participant identity', async () => {
    prisma.rescheduleRequest.findUnique.mockResolvedValue({
      createdById: TEACHER.id,
      lesson: { teacherId: TEACHER.id, studentId: STUDENT.id },
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: TEACHER.id,
        staffRoles: [Role.ADMIN],
        teacherProfile: { userId: TEACHER.id },
        studentProfile: null,
      },
      {
        id: STUDENT.id,
        staffRoles: [],
        teacherProfile: null,
        studentProfile: { userId: STUDENT.id },
      },
    ]);

    await expect(resolveTelegramActor(service, 100, 'rr1')).resolves.toEqual({
      id: TEACHER.id,
      roles: [Role.ADMIN, Role.TEACHER],
    });
  });
});
