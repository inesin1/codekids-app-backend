-- Phase 1: PK ролевых профилей = userId. Убираем отдельный cuid `id`,
-- все FK (enrollment/lesson/schedule/payout/payment/transaction/telegram/student.parent)
-- начинают ссылаться на userId. Значения FK ремапятся через старый id -> userId.

-- 1. Снимаем FK, указывающие на profile.id
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_teacherId_fkey";
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_studentId_fkey";
ALTER TABLE "schedule_templates" DROP CONSTRAINT "schedule_templates_teacherId_fkey";
ALTER TABLE "schedule_templates" DROP CONSTRAINT "schedule_templates_studentId_fkey";
ALTER TABLE "lessons" DROP CONSTRAINT "lessons_teacherId_fkey";
ALTER TABLE "lessons" DROP CONSTRAINT "lessons_studentId_fkey";
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_teacherId_fkey";
ALTER TABLE "payments" DROP CONSTRAINT "payments_parentId_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_parentId_fkey";
ALTER TABLE "telegram_groups" DROP CONSTRAINT "telegram_groups_studentId_fkey";
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_parentId_fkey";

-- 2. Ремап значений FK: profile.id -> profile.userId
UPDATE "enrollments" e SET "teacherId" = tp."userId" FROM "teacher_profiles" tp WHERE e."teacherId" = tp."id";
UPDATE "enrollments" e SET "studentId" = sp."userId" FROM "student_profiles" sp WHERE e."studentId" = sp."id";
UPDATE "schedule_templates" s SET "teacherId" = tp."userId" FROM "teacher_profiles" tp WHERE s."teacherId" = tp."id";
UPDATE "schedule_templates" s SET "studentId" = sp."userId" FROM "student_profiles" sp WHERE s."studentId" = sp."id";
UPDATE "lessons" l SET "teacherId" = tp."userId" FROM "teacher_profiles" tp WHERE l."teacherId" = tp."id";
UPDATE "lessons" l SET "studentId" = sp."userId" FROM "student_profiles" sp WHERE l."studentId" = sp."id";
UPDATE "payouts" po SET "teacherId" = tp."userId" FROM "teacher_profiles" tp WHERE po."teacherId" = tp."id";
UPDATE "payments" pm SET "parentId" = pp."userId" FROM "parent_profiles" pp WHERE pm."parentId" = pp."id";
UPDATE "transactions" tr SET "parentId" = pp."userId" FROM "parent_profiles" pp WHERE tr."parentId" = pp."id";
UPDATE "telegram_groups" tg SET "studentId" = sp."userId" FROM "student_profiles" sp WHERE tg."studentId" = sp."id";
UPDATE "student_profiles" sp SET "parentId" = pp."userId" FROM "parent_profiles" pp WHERE sp."parentId" = pp."id";

-- 3. Меняем PK профилей с id на userId
ALTER TABLE "teacher_profiles" DROP CONSTRAINT "teacher_profiles_pkey";
DROP INDEX "teacher_profiles_userId_key";
ALTER TABLE "teacher_profiles" DROP COLUMN "id";
ALTER TABLE "teacher_profiles" ADD CONSTRAINT "teacher_profiles_pkey" PRIMARY KEY ("userId");

ALTER TABLE "parent_profiles" DROP CONSTRAINT "parent_profiles_pkey";
DROP INDEX "parent_profiles_userId_key";
ALTER TABLE "parent_profiles" DROP COLUMN "id";
ALTER TABLE "parent_profiles" ADD CONSTRAINT "parent_profiles_pkey" PRIMARY KEY ("userId");

ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_pkey";
DROP INDEX "student_profiles_userId_key";
ALTER TABLE "student_profiles" DROP COLUMN "id";
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("userId");

-- 4. Возвращаем FK, теперь на userId
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teacher_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teacher_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teacher_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teacher_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parent_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parent_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_groups" ADD CONSTRAINT "telegram_groups_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parent_profiles"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
