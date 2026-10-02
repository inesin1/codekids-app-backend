jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Role } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../../core/users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    refreshToken: {
      findUnique: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    user: { findUnique: jest.Mock };
    refreshToken: { deleteMany: jest.Mock; create: jest.Mock };
  };
  let users: { findByLogin: jest.Mock };
  let jwt: { signAsync: jest.Mock };
  let config: { getOrThrow: jest.Mock };
  let compare: jest.Mock;

  const currentUser = () => ({
    id: 'u1',
    login: 'learner',
    email: 'family@example.test',
    password: 'password-hash',
    securityVersion: 7,
    isActive: true,
    staffRoles: [],
    teacherProfile: null,
    studentProfile: { userId: 'u1' },
  });

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'u1' }]),
      user: { findUnique: jest.fn().mockResolvedValue(currentUser()) },
      refreshToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      refreshToken: {
        findUnique: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    users = { findByLogin: jest.fn().mockResolvedValue(currentUser()) };
    jwt = { signAsync: jest.fn().mockResolvedValue('new.access.token') };
    config = { getOrThrow: jest.fn().mockReturnValue('30d') };
    compare = bcrypt.compare as jest.Mock;
    compare.mockResolvedValue(true);

    service = new AuthService(
      users as unknown as UsersService,
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    compare.mockReset();
  });

  it('signs current roles and security version into login tokens', async () => {
    const result = await service.login('learner', 'password');

    expect(users.findByLogin).toHaveBeenCalledWith('learner');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'u1',
      roles: [Role.STUDENT],
      securityVersion: 7,
    });
    expect(tx.refreshToken.create).toHaveBeenCalled();
    expect(result.accessToken).toBe('new.access.token');
    expect(result.user.roles).toEqual([Role.STUDENT]);
    expect(result.user).not.toHaveProperty('password');
    expect(result.user).not.toHaveProperty('securityVersion');
  });

  it('rechecks active status and credentials while holding the user lock', async () => {
    tx.user.findUnique.mockResolvedValue({
      ...currentUser(),
      isActive: false,
    });

    await expect(service.login('learner', 'password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rotates a refresh token after locking the user and consumes it once', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1_000_000),
    });

    const result = await service.refresh('old-token');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [[consumeArgs]] = tx.refreshToken.deleteMany.mock
      .calls as unknown as [
      [{ where: { id: string; expiresAt: { gt: Date } } }],
    ];
    expect(consumeArgs.where.id).toBe('rt1');
    expect(consumeArgs.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(tx.refreshToken.create).toHaveBeenCalled();
    expect(result.user).not.toHaveProperty('password');
    expect(result.user).not.toHaveProperty('securityVersion');
    expect(result.user.roles).toEqual([Role.STUDENT]);
  });

  it('rejects the concurrent refresh loser without issuing another session', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1_000_000),
    });
    tx.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh('old-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('leaves refresh creation inside the rotation transaction if signing fails', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1_000_000),
    });
    jwt.signAsync.mockRejectedValue(new Error('sign failed'));

    await expect(service.refresh('old-token')).rejects.toThrow('sign failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.deleteMany).toHaveBeenCalled();
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects unknown and expired refresh tokens', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    await expect(service.refresh('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'expired',
      userId: 'u1',
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(service.refresh('expired-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const [[expiredArgs]] = prisma.refreshToken.deleteMany.mock
      .calls as unknown as [
      [{ where: { id: string; expiresAt: { lte: Date } } }],
    ];
    expect(expiredArgs.where.id).toBe('expired');
    expect(expiredArgs.where.expiresAt.lte).toBeInstanceOf(Date);
  });
});
