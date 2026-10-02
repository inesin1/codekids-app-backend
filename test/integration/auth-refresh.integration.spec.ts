import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import { Role } from '../../src/generated/client';
import { AuthService } from '../../src/modules/common/auth/auth.service';
import { AuditService } from '../../src/modules/common/audit/audit.service';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { UsersService } from '../../src/modules/core/users/users.service';
import { JwtAuthGuard } from '../../src/modules/common/auth/guards/auth.guard';

describe('AuthService refresh with PostgreSQL', () => {
  let prisma: PrismaService;
  let userId: string;
  let jwt: { signAsync: jest.Mock };
  let service: AuthService;

  beforeAll(async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return process.env['DATABASE_URL'];
        if (key === 'JWT_REFRESH_TTL') return '1d';
        throw new Error(`Unexpected config key: ${key}`);
      },
    } as ConfigService;
    prisma = new PrismaService(config);
    await prisma.$connect();
  });

  beforeEach(async () => {
    userId = `integration-student-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: userId,
        firstName: 'Integration',
        lastName: 'Student',
        studentProfile: { create: {} },
      },
    });
    jwt = {
      signAsync: jest.fn().mockResolvedValue('integration-access-token'),
    };
    service = new AuthService(
      {} as UsersService,
      jwt as unknown as JwtService,
      prisma,
      {
        getOrThrow: (key: string) => {
          if (key === 'JWT_REFRESH_TTL') return '1d';
          throw new Error(`Unexpected config key: ${key}`);
        },
      } as ConfigService,
    );
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows one winner when two requests rotate the same refresh token concurrently', async () => {
    const oldToken = `refresh-${randomUUID()}`;
    const oldHash = hashToken(oldToken);
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: oldHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const outcomes = await Promise.allSettled([
      service.refresh(oldToken),
      service.refresh(oldToken),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const currentTokens = await prisma.refreshToken.findMany({
      where: { userId },
    });
    expect(currentTokens).toHaveLength(1);
    expect(currentTokens[0].tokenHash).not.toBe(oldHash);
    expect(jwt.signAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps the consumed refresh token when minting the replacement access token fails', async () => {
    const oldToken = `refresh-${randomUUID()}`;
    const oldHash = hashToken(oldToken);
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: oldHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    jwt.signAsync.mockRejectedValueOnce(new Error('synthetic signing failure'));

    await expect(service.refresh(oldToken)).rejects.toThrow(
      'synthetic signing failure',
    );

    const currentTokens = await prisma.refreshToken.findMany({
      where: { userId },
    });
    expect(currentTokens).toHaveLength(1);
    expect(currentTokens[0].tokenHash).toBe(oldHash);
  });

  it('rejects refresh for a deactivated student without issuing a replacement', async () => {
    const oldToken = `refresh-${randomUUID()}`;
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });

    await expect(service.refresh(oldToken)).rejects.toMatchObject({
      status: 401,
    });

    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(1);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('resolves only the student role from the current profile', async () => {
    const oldToken = `refresh-${randomUUID()}`;
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await service.refresh(oldToken);

    expect(result.user.roles).toEqual([Role.STUDENT]);
  });

  it('revokes access tokens after access changes, deactivation, or loss of the student role', async () => {
    let tokenVersion = 0;
    const request = {
      headers: { authorization: 'Bearer signed-access-token' },
    };
    const context = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockImplementation(() => ({
          sub: userId,
          securityVersion: tokenVersion,
        })),
      } as unknown as JwtService,
      { getOrThrow: () => 'integration-secret' } as unknown as ConfigService,
      { getAllAndOverride: () => false } as unknown as Reflector,
      prisma,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await prisma.user.update({
      where: { id: userId },
      data: { securityVersion: { increment: 1 } },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });

    tokenVersion = 1;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });

    await prisma.user.update({
      where: { id: userId },
      data: { isActive: true },
    });
    await prisma.studentProfile.delete({ where: { userId } });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('deactivates a user and revokes refresh sessions in one UsersService transaction', async () => {
    const oldToken = `refresh-${randomUUID()}`;
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const users = new UsersService(prisma, {
      record: jest.fn(),
    } as unknown as AuditService);

    await users.update(userId, { isActive: false });

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      omit: { securityVersion: false },
    });
    expect(current.isActive).toBe(false);
    expect(current.securityVersion).toBe(1);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
    await expect(service.refresh(oldToken)).rejects.toMatchObject({
      status: 401,
    });
  });

  it.each([
    [
      'credential replacement',
      { login: 'refresh-race-renamed', password: 'replacement-password' },
    ],
    ['deactivation', { isActive: false }],
  ])(
    'serializes refresh against a concurrent %s update',
    async (_label, update) => {
      const oldToken = `refresh-${randomUUID()}`;
      await prisma.refreshToken.create({
        data: {
          userId,
          tokenHash: hashToken(oldToken),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const users = new UsersService(prisma, {
        record: jest.fn(),
      } as unknown as AuditService);

      let releaseRowLock!: () => void;
      let reportRowLock!: () => void;
      const rowLockAcquired = new Promise<void>((resolve) => {
        reportRowLock = resolve;
      });
      const holdRowLock = new Promise<void>((resolve) => {
        releaseRowLock = resolve;
      });
      const lockTransaction = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
        reportRowLock();
        await holdRowLock;
      });
      await rowLockAcquired;

      try {
        const refreshOutcome = service.refresh(oldToken).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        await waitForBlockedQuery(
          prisma,
          '%SELECT "id" FROM "users"%FOR UPDATE%',
        );

        const updateOutcome = users.update(userId, update);
        await waitForBlockedQuery(prisma, '%UPDATE%users%');

        releaseRowLock();
        await lockTransaction;
        const [refreshResult] = await Promise.all([
          refreshOutcome,
          updateOutcome,
        ]);

        const current = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          omit: { securityVersion: false },
        });
        expect(current.securityVersion).toBe(1);
        expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);

        if (refreshResult.status === 'fulfilled') {
          await expect(
            service.refresh(refreshResult.value.refreshToken),
          ).rejects.toMatchObject({
            status: 401,
          });
        } else {
          expect(refreshResult.error).toMatchObject({ status: 401 });
        }

        if ('isActive' in update && update.isActive === false) {
          expect(current.isActive).toBe(false);
        } else {
          expect(current.login).toBe('refresh-race-renamed');
        }
      } finally {
        releaseRowLock();
        await lockTransaction;
      }
    },
  );

  it('rejects login by an old identifier when a same-password rename wins after the row lock', async () => {
    const users = new UsersService(prisma, {
      record: jest.fn(),
    } as unknown as AuditService);
    const password = 'stable-login-password';
    await users.update(userId, { login: 'login-before-rename', password });
    const loginJwt = {
      signAsync: jest.fn().mockResolvedValue('unexpected-access-token'),
    };
    const loginService = new AuthService(
      users,
      loginJwt as unknown as JwtService,
      prisma,
      {
        getOrThrow: (key: string) => {
          if (key === 'JWT_REFRESH_TTL') return '1d';
          throw new Error(`Unexpected config key: ${key}`);
        },
      } as ConfigService,
    );

    let releaseRowLock!: () => void;
    let reportRowLock!: () => void;
    const rowLockAcquired = new Promise<void>((resolve) => {
      reportRowLock = resolve;
    });
    const holdRowLock = new Promise<void>((resolve) => {
      releaseRowLock = resolve;
    });
    const lockTransaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      reportRowLock();
      await holdRowLock;
    });
    await rowLockAcquired;

    try {
      const renameOutcome = users.update(userId, {
        login: 'login-after-rename',
        password,
      });
      await waitForBlockedQuery(prisma, '%UPDATE%users%');

      const loginOutcome = loginService
        .login('login-before-rename', password)
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
      await waitForBlockedQuery(
        prisma,
        '%SELECT "id" FROM "users"%FOR UPDATE%',
      );

      releaseRowLock();
      await lockTransaction;
      const [loginResult] = await Promise.all([loginOutcome, renameOutcome]);

      expect(loginResult.status).toBe('rejected');
      if (loginResult.status === 'rejected') {
        expect(loginResult.error).toMatchObject({ status: 401 });
      }
      expect(loginJwt.signAsync).not.toHaveBeenCalled();
      expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      ).toMatchObject({ login: 'login-after-rename' });
    } finally {
      releaseRowLock();
      await lockTransaction;
    }
  });
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function waitForBlockedQuery(
  prisma: PrismaService,
  queryPattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE ${queryPattern}
    `;
    if (rows[0]?.count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for a blocked query matching ${queryPattern}`,
  );
}
