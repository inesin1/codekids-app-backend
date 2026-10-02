BEGIN;
INSERT INTO "courses" ("id", "name", "updatedAt")
VALUES ('legacy_inconsistent_course', 'Synthetic inconsistent enrollment', CURRENT_TIMESTAMP);
INSERT INTO "enrollments" ("id", "teacherId", "studentId", "courseId", "lessonPrice", "teacherRate", "updatedAt")
VALUES ('legacy_inconsistent_enrollment', 'legacy_parent_staff_teacher', 'legacy_child_no_access', 'legacy_inconsistent_course', 100.00, 50.00, CURRENT_TIMESTAMP);
INSERT INTO "lessons" ("id", "enrollmentId", "teacherId", "studentId", "scheduledAt", "updatedAt")
VALUES ('legacy_inconsistent_lesson', 'legacy_inconsistent_enrollment', 'legacy_parent_staff_teacher', 'legacy_child_with_access', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
COMMIT;
