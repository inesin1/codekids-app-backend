-- Phase 2: roles -> staffRoles. В колонке остаются только ADMIN/MANAGER,
-- участие TEACHER/PARENT/STUDENT теперь определяется наличием профиля.
ALTER TABLE "users" RENAME COLUMN "roles" TO "staffRoles";

UPDATE "users"
SET "staffRoles" = ARRAY(
  SELECT r FROM unnest("staffRoles") AS r WHERE r IN ('ADMIN', 'MANAGER')
)::"Role"[];

ALTER TABLE "users" ALTER COLUMN "staffRoles" SET DEFAULT ARRAY[]::"Role"[];
ALTER TABLE "users" ALTER COLUMN "staffRoles" SET NOT NULL;
