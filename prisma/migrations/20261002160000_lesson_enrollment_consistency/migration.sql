BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "lessons" lesson
    JOIN "enrollments" enrollment ON enrollment."id" = lesson."enrollmentId"
    WHERE lesson."teacherId" IS DISTINCT FROM enrollment."teacherId"
       OR lesson."studentId" IS DISTINCT FROM enrollment."studentId"
  ) THEN
    RAISE EXCEPTION 'Cannot add lesson enrollment constraint: lesson participants differ from enrollment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "schedule_templates" template
    JOIN "enrollments" enrollment ON enrollment."id" = template."enrollmentId"
    WHERE template."teacherId" IS DISTINCT FROM enrollment."teacherId"
       OR template."studentId" IS DISTINCT FROM enrollment."studentId"
  ) THEN
    RAISE EXCEPTION 'Cannot add schedule template enrollment constraint: template participants differ from enrollment';
  END IF;
END $$;

CREATE UNIQUE INDEX "enrollments_id_teacherId_studentId_key"
  ON "enrollments"("id", "teacherId", "studentId");

ALTER TABLE "lessons"
  DROP CONSTRAINT "lessons_enrollmentId_fkey",
  ADD CONSTRAINT "lessons_enrollmentId_teacherId_studentId_fkey"
    FOREIGN KEY ("enrollmentId", "teacherId", "studentId")
    REFERENCES "enrollments"("id", "teacherId", "studentId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "schedule_templates"
  DROP CONSTRAINT "schedule_templates_enrollmentId_fkey",
  ADD CONSTRAINT "schedule_templates_enrollmentId_teacherId_studentId_fkey"
    FOREIGN KEY ("enrollmentId", "teacherId", "studentId")
    REFERENCES "enrollments"("id", "teacherId", "studentId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
