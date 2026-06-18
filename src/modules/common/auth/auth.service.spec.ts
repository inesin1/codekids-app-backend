import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../../core/users/users.service';
import { AuthService } from './auth.service';

describe('AuthService.refresh', () => {
  let service: AuthService;
  let prisma: {
    refreshToken: {
      findUnique: jest.Mock;
      delete: jest.Mock;
      create: jest.Mock;
    };
    user: { findUnique: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock };
  let config: { getOrThrow: jest.Mock };

  beforeEach(() => {
    prisma = {
      refreshToken: {
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn() },
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('new.access.token') };
    config = { getOrThrow: jest.fn().mockReturnValue('30d') };

    service = new AuthService(
      {} as unknown as UsersService,
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('должен ротировать токен: удалить старый и выдать новый', async () => {
    // Arrange
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1_000_000),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      roles: [Role.TEACHER],
      password: 'hash',
    });

    // Act
    const result = await service.refresh('old-token');

    // Assert
    expect(prisma.refreshToken.delete).toHaveBeenCalledWith({
      where: { id: 'rt1' },
    });
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(result.accessToken).toBe('new.access.token');
    expect(result.refreshToken).toBeDefined();
    expect((result.user as Record<string, unknown>).password).toBeUndefined();
  });

  it('должен бросать Unauthorized для неизвестного токена', async () => {
    // Arrange
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    // Act + Assert
    await expect(service.refresh('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('должен удалять истёкший токен и бросать Unauthorized', async () => {
    // Arrange
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      expiresAt: new Date(Date.now() - 1_000),
    });

    // Act + Assert
    await expect(service.refresh('expired')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.delete).toHaveBeenCalledWith({
      where: { id: 'rt1' },
    });
  });
});
