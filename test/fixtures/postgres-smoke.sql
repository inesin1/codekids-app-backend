BEGIN;

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.teacher_profiles') IS NULL
     OR to_regclass('public.courses') IS NULL THEN
    RAISE EXCEPTION 'Required integration tables are missing';
  END IF;
END $$;

INSERT INTO "users" ("id", "firstName", "lastName", "staffRoles", "updatedAt")
VALUES ('integration_teacher', 'Integration', 'Teacher', ARRAY[]::"Role"[], CURRENT_TIMESTAMP);

INSERT INTO "teacher_profiles" ("userId", "updatedAt")
VALUES ('integration_teacher', CURRENT_TIMESTAMP);

INSERT INTO "courses" ("id", "name", "updatedAt")
VALUES ('integration_course', 'Integration course', CURRENT_TIMESTAMP);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "teacher_profiles" AS teacher
    JOIN "users" AS app_user ON app_user."id" = teacher."userId"
    WHERE teacher."userId" = 'integration_teacher'
  ) OR NOT EXISTS (
    SELECT 1 FROM "courses" WHERE "id" = 'integration_course'
  ) THEN
    RAISE EXCEPTION 'Minimal teacher and course fixture could not be read';
  END IF;
END $$;

ROLLBACK;
