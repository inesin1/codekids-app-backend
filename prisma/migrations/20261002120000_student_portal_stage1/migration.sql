BEGIN;

-- Do not guess where parent-owned balances or ledger rows belong.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "student_profiles"
    GROUP BY "parentId"
    HAVING "parentId" IS NOT NULL AND COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate parent data: a parent is linked to multiple students';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "users" WHERE 'PARENT'::"Role" = ANY("staffRoles")
  ) THEN
    RAISE EXCEPTION 'Cannot migrate staff roles: PARENT is stored in staffRoles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "parent_profiles" pp
    WHERE pp."balance" <> 0
      AND (SELECT COUNT(*) FROM "student_profiles" sp WHERE sp."parentId" = pp."userId") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate parent balance: parent is not linked to exactly one student';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "payments" p
    WHERE (SELECT COUNT(*) FROM "student_profiles" sp WHERE sp."parentId" = p."parentId") <> 1
  ) OR EXISTS (
    SELECT 1
    FROM "transactions" t
    WHERE (SELECT COUNT(*) FROM "student_profiles" sp WHERE sp."parentId" = t."parentId") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate parent ledger: a payment or transaction is not linked to exactly one student';
  END IF;
END $$;

ALTER TABLE "users"
  ADD COLUMN "login" TEXT,
  ADD COLUMN "securityVersion" INTEGER NOT NULL DEFAULT 0;

UPDATE "users" SET "login" = CASE WHEN "password" IS NOT NULL THEN "email" END;

ALTER TABLE "student_profiles"
  ADD COLUMN "parentName" TEXT,
  ADD COLUMN "parentContacts" JSONB,
  ADD COLUMN "balance" DECIMAL(12,2) NOT NULL DEFAULT 0;

DROP INDEX "users_telegramChatId_key";
CREATE INDEX "users_telegramChatId_idx" ON "users"("telegramChatId");

UPDATE "student_profiles" sp
SET "parentName" = NULLIF(BTRIM(CONCAT_WS(' ', parent."firstName", parent."lastName")), ''),
    "parentContacts" =
      CASE
        WHEN parent."email" IS NULL THEN contacts.items
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(contacts.items) contact
          WHERE LOWER(contact ->> 'value') = LOWER(parent."email")
        ) THEN contacts.items
        ELSE contacts.items || jsonb_build_array(jsonb_build_object('label', 'Email', 'value', parent."email"))
      END,
    "balance" = pp."balance"
FROM "parent_profiles" pp
JOIN "users" parent ON parent."id" = pp."userId"
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN jsonb_typeof(parent."contacts") = 'array' THEN parent."contacts"
    ELSE '[]'::jsonb
  END AS items
) contacts
WHERE sp."parentId" = pp."userId";

-- A parent-only credential becomes the child's credential only when the child
-- has no portal access yet. Existing student credentials take precedence.
UPDATE "users" student
SET "login" = parent."login",
    "password" = parent."password",
    "securityVersion" = student."securityVersion" + 1
FROM "student_profiles" sp
JOIN "parent_profiles" pp ON pp."userId" = sp."parentId"
JOIN "users" parent ON parent."id" = pp."userId"
WHERE student."id" = sp."userId"
  AND student."login" IS NULL
  AND student."password" IS NULL
  AND parent."login" IS NOT NULL
  AND parent."password" IS NOT NULL
  AND parent."staffRoles" = ARRAY[]::"Role"[]
  AND NOT EXISTS (SELECT 1 FROM "teacher_profiles" tp WHERE tp."userId" = parent."id")
  AND NOT EXISTS (SELECT 1 FROM "student_profiles" other_sp WHERE other_sp."userId" = parent."id");

UPDATE "users" student
SET "telegramChatId" = parent."telegramChatId"
FROM "student_profiles" sp
JOIN "parent_profiles" pp ON pp."userId" = sp."parentId"
JOIN "users" parent ON parent."id" = pp."userId"
WHERE student."id" = sp."userId"
  AND student."telegramChatId" IS NULL
  AND parent."telegramChatId" IS NOT NULL
  AND parent."staffRoles" = ARRAY[]::"Role"[]
  AND NOT EXISTS (SELECT 1 FROM "teacher_profiles" tp WHERE tp."userId" = parent."id")
  AND NOT EXISTS (SELECT 1 FROM "student_profiles" other_sp WHERE other_sp."userId" = parent."id");

-- Parent-only users are retained for audit/history, but cannot remain a second
-- active portal account after their data has moved to the student.
UPDATE "users" parent
SET "login" = NULL,
    "password" = NULL,
    "telegramChatId" = NULL,
    "isActive" = false,
    "securityVersion" = parent."securityVersion" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "parent_profiles" pp WHERE pp."userId" = parent."id")
  AND parent."staffRoles" = ARRAY[]::"Role"[]
  AND NOT EXISTS (SELECT 1 FROM "teacher_profiles" tp WHERE tp."userId" = parent."id")
  AND NOT EXISTS (SELECT 1 FROM "student_profiles" sp WHERE sp."userId" = parent."id");

DELETE FROM "refresh_tokens";
DELETE FROM "telegram_link_tokens";

ALTER TABLE "payments" DROP CONSTRAINT "payments_parentId_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_parentId_fkey";
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_parentId_fkey";

UPDATE "payments" p
SET "parentId" = sp."userId"
FROM "student_profiles" sp
WHERE sp."parentId" = p."parentId";

UPDATE "transactions" t
SET "parentId" = sp."userId"
FROM "student_profiles" sp
WHERE sp."parentId" = t."parentId";

ALTER TABLE "payments" RENAME COLUMN "parentId" TO "studentId";
ALTER TABLE "transactions" RENAME COLUMN "parentId" TO "studentId";
DROP INDEX "payments_parentId_idx";
DROP INDEX "transactions_parentId_idx";
CREATE INDEX "payments_studentId_idx" ON "payments"("studentId");
CREATE INDEX "transactions_studentId_idx" ON "transactions"("studentId");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "student_profiles_parentId_idx";
ALTER TABLE "student_profiles" DROP COLUMN "parentId";
DROP TABLE "parent_profiles";

DROP INDEX "users_email_key";
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");

ALTER TABLE "users" ALTER COLUMN "staffRoles" DROP DEFAULT;
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'MANAGER', 'TEACHER', 'STUDENT');
ALTER TABLE "users"
  ALTER COLUMN "staffRoles" TYPE "Role_new"[]
  USING ("staffRoles"::TEXT[]::"Role_new"[]);
ALTER TABLE "users" ALTER COLUMN "staffRoles" SET DEFAULT ARRAY[]::"Role_new"[];
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";

COMMIT;
