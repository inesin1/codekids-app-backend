-- Добавление обязательного "courseId" в enrollments.
-- ВАЖНО: запустить ДО `prisma db push`, иначе push потребует значение для
-- существующих строк и упадёт.
--
--   pnpm prisma db execute --file prisma/backfill-courses.sql --schema prisma
--   pnpm prisma db push
--
-- Скрипт создаёт справочную таблицу/дефолтный курс (если их ещё нет) и
-- проставляет его существующим enrollment'ам. После push останется чистый
-- constraint UNIQUE(teacherId, studentId, courseId).

-- 1. Таблица курсов (на случай, если push ещё не создал её).
CREATE TABLE IF NOT EXISTS "courses" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "courses_name_key" ON "courses" ("name");

-- 2. Дефолтный курс для старых записей.
INSERT INTO "courses" ("id", "name", "description", "createdAt", "updatedAt")
  VALUES ('course_default', 'Не указано', 'Дефолтный курс для существующих записей',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("name") DO NOTHING;

-- 3. Колонка + бэкфилл существующих enrollment'ов.
ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "courseId" TEXT;

UPDATE "enrollments"
  SET "courseId" = (SELECT "id" FROM "courses" WHERE "name" = 'Не указано')
  WHERE "courseId" IS NULL;
