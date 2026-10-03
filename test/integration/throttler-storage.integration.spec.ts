import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { PostgresThrottlerStorage } from '../../src/modules/common/throttling/postgres-throttler.storage';

describe('shared PostgreSQL throttler storage', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const config = {
      getOrThrow: () => process.env['DATABASE_URL'],
    } as unknown as ConfigService;
    prisma = new PrismaService(config);
    await prisma.$connect();
  });

  afterAll(async () => prisma?.$disconnect());

  it('serializes concurrent increments across workers', async () => {
    const key = `integration:${randomUUID()}`;
    const storage = new PostgresThrottlerStorage(prisma);
    try {
      const results = await Promise.all(
        Array.from({ length: 24 }, () =>
          storage.increment(key, 60_000, 5, 30_000, 'default'),
        ),
      );
      expect(Math.max(...results.map(({ totalHits }) => totalHits))).toBe(6);
      expect(results.some(({ isBlocked }) => isBlocked)).toBe(true);
      expect(
        await storage.increment(key, 60_000, 5, 30_000, 'default'),
      ).toMatchObject({ totalHits: 6, isBlocked: true });

      await prisma.$executeRaw`UPDATE "rate_limit_buckets"
        SET "blockedUntil" = now() - interval '1 millisecond'
        WHERE "key" = ${`default:${key}`}`;
      expect(
        await storage.increment(key, 60_000, 5, 30_000, 'default'),
      ).toMatchObject({ totalHits: 1, isBlocked: false });
    } finally {
      await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ${`default:${key}`}`;
    }
  });
});
