-- CreateTable
CREATE TABLE "lesson_generation_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "triggerDay" "DayOfWeek" NOT NULL DEFAULT 'MONDAY',
    "daysAhead" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_generation_settings_pkey" PRIMARY KEY ("id")
);
