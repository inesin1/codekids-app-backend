-- AlterTable
ALTER TABLE "schedule_templates" ALTER COLUMN "timezone" SET DEFAULT 'Europe/Moscow';

-- Существующие строки получили старый дефолт при бэкфилле — переводим на новый
UPDATE "schedule_templates" SET "timezone" = 'Europe/Moscow' WHERE "timezone" = 'Asia/Tbilisi';
