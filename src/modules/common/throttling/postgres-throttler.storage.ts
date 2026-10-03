import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BUSINESS_TIMEZONE } from '../business-time';

@Injectable()
export class PostgresThrottlerStorage {
  constructor(private readonly prisma: PrismaService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    name: string,
  ) {
    const [row] = await this.prisma.$queryRaw<
      Array<{
        totalHits: number;
        timeToExpire: number;
        isBlocked: boolean;
        timeToBlockExpire: number;
      }>
    >(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("key", "totalHits", "expiresAt")
      VALUES (${`${name}:${key}`}, 1, now() + (${ttl} * interval '1 millisecond'))
      ON CONFLICT ("key") DO UPDATE SET
        "totalHits" = CASE
          WHEN "rate_limit_buckets"."blockedUntil" > now() THEN "rate_limit_buckets"."totalHits"
          WHEN "rate_limit_buckets"."blockedUntil" IS NOT NULL OR "rate_limit_buckets"."expiresAt" <= now() THEN 1
          ELSE "rate_limit_buckets"."totalHits" + 1 END,
        "expiresAt" = CASE WHEN "rate_limit_buckets"."expiresAt" <= now() THEN now() + (${ttl} * interval '1 millisecond') ELSE "rate_limit_buckets"."expiresAt" END,
        "blockedUntil" = CASE
          WHEN "rate_limit_buckets"."blockedUntil" > now() THEN "rate_limit_buckets"."blockedUntil"
          WHEN "rate_limit_buckets"."blockedUntil" IS NOT NULL OR "rate_limit_buckets"."expiresAt" <= now() THEN NULL
          WHEN "rate_limit_buckets"."totalHits" + 1 > ${limit} THEN now() + (${blockDuration} * interval '1 millisecond')
          ELSE NULL END
      RETURNING "totalHits",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - now())) * 1000))::int AS "timeToExpire",
        COALESCE("blockedUntil" > now(), false) AS "isBlocked",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - now())) * 1000))::int AS "timeToBlockExpire"
    `);
    return row;
  }

  @Cron('0 * * * *', { timeZone: BUSINESS_TIMEZONE })
  pruneExpired() {
    return this.prisma.$executeRaw`DELETE FROM "rate_limit_buckets"
      WHERE "expiresAt" < now() - interval '1 day'
      AND ("blockedUntil" IS NULL OR "blockedUntil" < now())`;
  }
}
