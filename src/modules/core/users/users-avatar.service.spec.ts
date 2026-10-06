import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService avatars', () => {
  it('stores a PNG and returns a versioned private image URL', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
        update: jest.fn(),
      },
      userAvatar: {
        upsert: jest.fn().mockResolvedValue({
          updatedAt: new Date('2026-10-06T00:00:00.000Z'),
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { record: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    const data = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const result = await service.uploadAvatar('user-1', data);

    expect(tx.userAvatar.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: 'user-1', mimeType: 'image/png', data },
      }),
    );
    expect(result.avatarUrl).toBe(
      `/users/user-1/avatar?v=${new Date('2026-10-06T00:00:00.000Z').getTime()}`,
    );
    expect(audit.record).toHaveBeenCalled();
  });

  it('rejects data without a supported image signature', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(
      service.uploadAvatar('user-1', Uint8Array.from([1, 2, 3])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
