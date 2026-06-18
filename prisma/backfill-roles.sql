-- Миграция single-role -> multi-role.
-- ВАЖНО: запустить ДО `prisma db push` (пока колонка "role" ещё существует),
-- иначе db push дропнет "role" и данные ролей потеряются.
--
--   pnpm prisma db execute --file prisma/backfill-roles.sql --schema prisma
--   pnpm prisma db push
--
-- После db push колонка "role" будет удалена, останется "roles".

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "roles" "Role"[] NOT NULL DEFAULT '{}';

UPDATE "users"
  SET "roles" = ARRAY["role"]::"Role"[]
  WHERE COALESCE(array_length("roles", 1), 0) = 0;
