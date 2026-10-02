DO $$
BEGIN
  IF to_regclass('public.parent_profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Student migration was not applied before the enrollment failure';
  END IF;
  IF to_regclass('public."enrollments_id_teacherId_studentId_key"') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lessons_enrollmentId_teacherId_studentId_fkey') THEN
    RAISE EXCEPTION 'Failed enrollment constraint migration left partial DDL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "lessons"
    WHERE "id" = 'legacy_inconsistent_lesson'
      AND "enrollmentId" = 'legacy_inconsistent_enrollment'
      AND "studentId" = 'legacy_child_with_access'
  ) OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lessons_enrollmentId_fkey') THEN
    RAISE EXCEPTION 'Failed enrollment constraint migration changed legacy data or its foreign key';
  END IF;
END $$;
