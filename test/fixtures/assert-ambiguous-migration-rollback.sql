DO $$
BEGIN
  IF to_regclass('public.parent_profiles') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'student_profiles' AND column_name = 'parentId'
     )
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'login'
     ) THEN
    RAISE EXCEPTION 'Ambiguous migration failure did not roll back schema changes';
  END IF;

  IF (SELECT "balance" FROM "parent_profiles" WHERE "userId" = 'ambiguous_parent') <> 25.00
     OR (SELECT COUNT(*) FROM "student_profiles" WHERE "parentId" = 'ambiguous_parent') <> 2
     OR (SELECT "isActive" FROM "users" WHERE "id" = 'ambiguous_parent') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Ambiguous migration failure changed legacy data';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE "migration_name" = '20261002120000_student_portal_stage1' AND "finished_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Ambiguous migration was recorded as successful';
  END IF;
END $$;
