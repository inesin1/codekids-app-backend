import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController readiness', () => {
  it('checks PostgreSQL and reports optional Telegram configuration', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const telegram = { readiness: 'disabled' };
    const controller = new HealthController(prisma as never, telegram as never);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ready',
      postgres: 'ready',
      telegram: 'disabled',
    });
  });

  it('reports failed optional Telegram initialization as degraded', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const telegram = { readiness: 'degraded_optional' };
    const controller = new HealthController(prisma as never, telegram as never);
    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ready',
      telegram: 'degraded_optional',
    });
  });

  it('returns not ready when PostgreSQL is unavailable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('offline')),
    };
    const controller = new HealthController(prisma as never, {} as never);
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
