import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
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
const PARENT = { id: 'parent', roles: [Role.PARENT] };
const OTHER_PARENT = { id: 'other-parent', roles: [Role.PARENT] };
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
    student: { parentId: PARENT.id },
  },
});

describe('RescheduleService.approve', () => {
  let service: RescheduleService;
  let prisma: {
    rescheduleRequest: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    rescheduleRequest: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let lessonsService: { cancelWithin: jest.Mock; rescheduleWithin: jest.Mock };

  beforeEach(() => {
    tx = {
      rescheduleRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      rescheduleRequest: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    lessonsService = { cancelWithin: jest.fn(), rescheduleWithin: jest.fn() };
    service = new RescheduleService(
      prisma as unknown as PrismaService,
      lessonsService as unknown as LessonsService,
      { log: jest.fn() } as unknown as AuditService,
      {} as TelegramService,
      {
        rescheduleRequestChanged: jest.fn(),
        lessonCanceled: jest.fn(),
        lessonRescheduled: jest.fn(),
      } as unknown as TelegramNotifier,
    );
  });

  it.each([
    ['заявку преподавателя — родитель ученика', TEACHER.id, PARENT],
    ['заявку родителя — преподаватель', PARENT.id, TEACHER],
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
  });

  it.each([
    ['преподавателю свою заявку', TEACHER.id, TEACHER],
    ['родителю свою заявку', PARENT.id, PARENT],
    ['чужому родителю', TEACHER.id, OTHER_PARENT],
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
    const act = service.approve('rr1', PARENT);

    // Assert
    await expect(act).rejects.toThrow(BadRequestException);
    expect(lessonsService.cancelWithin).not.toHaveBeenCalled();
  });
});
