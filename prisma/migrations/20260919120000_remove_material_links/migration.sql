DELETE FROM "materials" WHERE "fileData" IS NULL;
ALTER TABLE "materials" ALTER COLUMN "fileData" SET NOT NULL;
ALTER TABLE "materials" DROP COLUMN "fileUrl";
