import { BadRequestException } from '@nestjs/common';
import { DayOfWeek } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScheduleTemplatesService } from './schedule-templates.service';

const firstCallArg = <T>(mock: jest.Mock): T => {
  const calls = mock.mock.calls as unknown as Array<[T]>;
  return calls[0][0];
};

describe('ScheduleTemplatesService.create', () => {
  let service: ScheduleTemplatesService;
  let tx: {
    $queryRaw: jest.Mock;
    enrollment: { findUniqueOrThrow: jest.Mock };
    scheduleTemplate: { create: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'e1' }]),
      enrollment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'e1',
          teacherId: 't1',
          studentId: 's1',
        }),
      },
      scheduleTemplate: {
        create: jest.fn().mockResolvedValue({ id: 'template1' }),
      },
    };
    prisma = {
      $transaction: jest.fn((callback: (db: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ScheduleTemplatesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  const dto = {
    enrollmentId: 'e1',
    slots: [
      {
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '10:00',
        durationMinutes: 60,
      },
    ],
  };

  it('uses teacher and student from the enrollment when IDs are omitted', async () => {
    await service.create(dto);

    const createArgs = firstCallArg<{
      data: { enrollmentId: string; teacherId: string; studentId: string };
    }>(tx.scheduleTemplate.create);
    expect(createArgs.data).toEqual({
      enrollmentId: 'e1',
      teacherId: 't1',
      studentId: 's1',
      timezone: undefined,
      slots: {
        create: [
          {
            dayOfWeek: DayOfWeek.MONDAY,
            startTime: '10:00',
            durationMinutes: 60,
          },
        ],
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'schedule_template.created' }),
      tx,
    );
  });

  it('rejects participant IDs that disagree with the enrollment', async () => {
    await expect(
      service.create({ ...dto, studentId: 'unrelated-student' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.scheduleTemplate.create).not.toHaveBeenCalled();
  });
});
