import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

describe('AuditService.record', () => {
  it('propagates a persistence failure to abort the business transaction', async () => {
    const error = new Error('audit persistence failed');
    const create = jest.fn().mockRejectedValue(error);
    const outsideCreate = jest.fn();
    const service = new AuditService(
      { auditLog: { create: outsideCreate } } as unknown as PrismaService,
      { isActive: () => false } as unknown as ClsService,
    );

    await expect(
      service.record(
        {
          action: 'lesson.completed',
          entityType: 'Lesson',
          entityId: 'lesson',
        },
        { auditLog: { create } } as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toBe(error);
    expect(outsideCreate).not.toHaveBeenCalled();
  });
});
