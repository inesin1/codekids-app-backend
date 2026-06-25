-- Создаёт teacher_profiles для юзеров с ролью TEACHER без профиля.
INSERT INTO "teacher_profiles" ("id", "userId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users" u
WHERE u."roles" @> ARRAY['TEACHER']::"Role"[]
  AND NOT EXISTS (
    SELECT 1 FROM "teacher_profiles" tp WHERE tp."userId" = u."id"
  );
