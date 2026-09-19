CREATE TYPE "LessonReportStatus" AS ENUM ('DRAFT', 'SUBMITTED');

ALTER TABLE "lesson_reports"
ADD COLUMN "status" "LessonReportStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "submittedAt" TIMESTAMP(3);

ALTER TABLE "materials" ADD COLUMN "reportId" TEXT;
ALTER TABLE "materials" ADD COLUMN "sentToTelegram" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "materials_reportId_idx" ON "materials"("reportId");

ALTER TABLE "materials"
ADD CONSTRAINT "materials_reportId_fkey"
FOREIGN KEY ("reportId") REFERENCES "lesson_reports"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
