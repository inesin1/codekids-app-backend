ALTER TABLE "users" ADD COLUMN "birthDate" DATE;
UPDATE "users" AS u SET "birthDate" = sp."birthDate" FROM "student_profiles" AS sp WHERE sp."userId" = u."id";
ALTER TABLE "student_profiles" DROP COLUMN "birthDate";
