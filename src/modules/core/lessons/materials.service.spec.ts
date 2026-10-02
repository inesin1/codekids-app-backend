import { NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';
import { MaterialsService } from './materials.service';

describe('MaterialsService.remove', () => {
  it('does not delete a material from a different lesson even for staff', async () => {
    const material = {
      findFirst: jest.fn().mockResolvedValue(null),
      delete: jest.fn(),
    };
    const service = new MaterialsService(
      { material } as unknown as PrismaService,
      {} as AuditService,
      {} as TelegramNotifier,
    );

    await expect(
      service.remove('foreign-file', 'route-lesson'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(material.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-file', lessonId: 'route-lesson' },
      select: { lessonId: true },
    });
    expect(material.delete).not.toHaveBeenCalled();
  });
});
