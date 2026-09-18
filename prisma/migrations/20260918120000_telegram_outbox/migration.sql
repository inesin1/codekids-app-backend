-- CreateEnum
CREATE TYPE "TelegramLinkKind" AS ENUM ('GROUP', 'PRIVATE');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'STAFF_DIGEST';

-- DropForeignKey
ALTER TABLE "telegram_groups" DROP CONSTRAINT "telegram_groups_studentId_fkey";

-- DropForeignKey
ALTER TABLE "telegram_notifications" DROP CONSTRAINT "telegram_notifications_groupId_fkey";

-- DropIndex
DROP INDEX "telegram_notifications_createdAt_idx";

-- DropIndex
DROP INDEX "telegram_notifications_groupId_idx";

-- DropIndex
DROP INDEX "telegram_notifications_type_idx";

-- AlterTable
ALTER TABLE "telegram_notifications" DROP COLUMN "groupId",
DROP COLUMN "payload",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chatId" TEXT NOT NULL,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "replyMarkup" JSONB,
ADD COLUMN     "text" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "telegramMessageId",
ADD COLUMN     "telegramMessageId" INTEGER;

-- CreateTable
CREATE TABLE "telegram_link_tokens" (
    "token" TEXT NOT NULL,
    "kind" "TelegramLinkKind" NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "telegram_link_tokens_userId_idx" ON "telegram_link_tokens"("userId");

-- CreateIndex
CREATE INDEX "telegram_notifications_sentAt_idx" ON "telegram_notifications"("sentAt");

-- CreateIndex
CREATE INDEX "telegram_notifications_type_entityId_idx" ON "telegram_notifications"("type", "entityId");

-- AddForeignKey
ALTER TABLE "telegram_groups" ADD CONSTRAINT "telegram_groups_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

