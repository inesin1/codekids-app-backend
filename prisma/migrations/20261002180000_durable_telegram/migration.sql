BEGIN;
ALTER TABLE "users" ADD COLUMN "telegramBindingVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "telegram_groups" ALTER COLUMN "telegramChatId" DROP NOT NULL;
ALTER TABLE "telegram_groups" ADD COLUMN "bindingVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TYPE "TelegramRecipientKind" AS ENUM ('USER', 'GROUP');
ALTER TABLE "telegram_notifications"
  ADD COLUMN "eventKey" TEXT,
  ADD COLUMN "occurrenceKey" TEXT,
  ADD COLUMN "recipientKind" "TelegramRecipientKind",
  ADD COLUMN "recipientId" TEXT,
  ADD COLUMN "bindingVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payloadHash" TEXT,
  ADD COLUMN "desiredVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deliveredVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseVersion" INTEGER,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "canceledAt" TIMESTAMP(3);
UPDATE "telegram_notifications" SET
  "eventKey" = 'legacy:' || "id",
  "occurrenceKey" = 'legacy',
  "payloadHash" = 'legacy',
  "deliveredVersion" = CASE WHEN "sentAt" IS NOT NULL THEN 1 ELSE 0 END,
  "canceledAt" = CASE WHEN "sentAt" IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END;
ALTER TABLE "telegram_notifications"
  ALTER COLUMN "eventKey" SET NOT NULL,
  ALTER COLUMN "occurrenceKey" SET NOT NULL,
  ALTER COLUMN "payloadHash" SET NOT NULL;
CREATE UNIQUE INDEX "telegram_notifications_eventKey_key" ON "telegram_notifications"("eventKey");
CREATE INDEX "telegram_notifications_nextAttemptAt_leaseExpiresAt_idx" ON "telegram_notifications"("nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "telegram_notifications_recipient_binding_idx" ON "telegram_notifications"("recipientKind", "recipientId", "bindingVersion");
ALTER TABLE "telegram_link_tokens" ADD COLUMN "bindingVersion" INTEGER NOT NULL DEFAULT 0;
DELETE FROM "telegram_link_tokens";
CREATE TABLE "telegram_update_inbox" (
  "updateId" BIGINT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_update_inbox_pkey" PRIMARY KEY ("updateId")
);
CREATE INDEX "telegram_update_inbox_ready_idx"
  ON "telegram_update_inbox"("processedAt", "failedAt", "nextAttemptAt", "leaseExpiresAt");
COMMIT;
