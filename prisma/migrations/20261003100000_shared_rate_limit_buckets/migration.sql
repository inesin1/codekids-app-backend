CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "totalHits" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "blockedUntil" TIMESTAMPTZ(6),
    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "rate_limit_buckets_expiresAt_idx" ON "rate_limit_buckets"("expiresAt");
