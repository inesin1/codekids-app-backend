-- Move single-slot schedule templates to explicit template slots.
CREATE TABLE "schedule_template_slots" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "dayOfWeek" "DayOfWeek" NOT NULL,
  "startTime" TEXT NOT NULL,
  "durationMinutes" INTEGER NOT NULL DEFAULT 60,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "schedule_template_slots_pkey" PRIMARY KEY ("id")
);

INSERT INTO "schedule_template_slots" (
  "id",
  "templateId",
  "dayOfWeek",
  "startTime",
  "durationMinutes",
  "isActive",
  "createdAt",
  "updatedAt"
)
SELECT
  'slot_' || "id",
  "id",
  "dayOfWeek",
  "startTime",
  "durationMinutes",
  "isActive",
  "createdAt",
  "updatedAt"
FROM "schedule_templates";

ALTER TABLE "schedule_template_slots"
  ADD CONSTRAINT "schedule_template_slots_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "schedule_templates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "schedule_template_slots_templateId_idx"
  ON "schedule_template_slots"("templateId");
CREATE INDEX "schedule_template_slots_dayOfWeek_idx"
  ON "schedule_template_slots"("dayOfWeek");
CREATE INDEX "schedule_template_slots_isActive_idx"
  ON "schedule_template_slots"("isActive");
CREATE INDEX "schedule_template_slots_templateId_isActive_idx"
  ON "schedule_template_slots"("templateId", "isActive");

CREATE INDEX "schedule_templates_isActive_idx"
  ON "schedule_templates"("isActive");
CREATE INDEX "lessons_templateId_scheduledAt_idx"
  ON "lessons"("templateId", "scheduledAt");

DROP INDEX IF EXISTS "schedule_templates_dayOfWeek_idx";

ALTER TABLE "schedule_templates"
  DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime",
  DROP COLUMN "durationMinutes";
