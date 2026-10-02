BEGIN;

INSERT INTO "users" ("id", "email", "contacts", "password", "firstName", "lastName", "staffRoles", "isActive", "telegramChatId", "updatedAt")
VALUES
  ('legacy_parent_only', 'parent-only@example.test', '[{"label":"Phone","value":"+10000000001"}]'::jsonb, 'legacy-parent-hash', 'Legacy', 'Parent', ARRAY[]::"Role"[], true, '90001', CURRENT_TIMESTAMP),
  ('legacy_child_no_access', 'child-no-access@example.test', NULL, NULL, 'Legacy', 'Child', ARRAY[]::"Role"[], true, NULL, CURRENT_TIMESTAMP),
  ('legacy_parent_staff_teacher', 'parent-staff@example.test', '[{"label":"Phone","value":"+10000000002"}]'::jsonb, 'legacy-staff-hash', 'Legacy', 'Staff Parent', ARRAY['MANAGER']::"Role"[], true, '90002', CURRENT_TIMESTAMP),
  ('legacy_child_with_access', 'child-access@example.test', NULL, 'child-own-hash', 'Legacy', 'Student', ARRAY[]::"Role"[], true, '90003', CURRENT_TIMESTAMP);

INSERT INTO "teacher_profiles" ("userId", "updatedAt")
VALUES ('legacy_parent_staff_teacher', CURRENT_TIMESTAMP);

INSERT INTO "parent_profiles" ("userId", "balance", "updatedAt")
VALUES
  ('legacy_parent_only', 12.34, CURRENT_TIMESTAMP),
  ('legacy_parent_staff_teacher', 7.50, CURRENT_TIMESTAMP);

INSERT INTO "student_profiles" ("userId", "parentId", "updatedAt")
VALUES
  ('legacy_child_no_access', 'legacy_parent_only', CURRENT_TIMESTAMP),
  ('legacy_child_with_access', 'legacy_parent_staff_teacher', CURRENT_TIMESTAMP);

INSERT INTO "payments" ("id", "parentId", "amount", "description")
VALUES ('legacy_payment', 'legacy_parent_only', 20.00, 'synthetic migration fixture');

INSERT INTO "transactions" ("id", "parentId", "type", "amount", "balanceBefore", "balanceAfter", "description")
VALUES ('legacy_transaction', 'legacy_parent_only', 'MANUAL_TOPUP', 20.00, 0.00, 20.00, 'synthetic migration fixture');

INSERT INTO "refresh_tokens" ("id", "userId", "tokenHash", "expiresAt")
VALUES
  ('legacy_refresh_parent', 'legacy_parent_only', 'synthetic-parent-refresh-hash', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('legacy_refresh_child', 'legacy_child_no_access', 'synthetic-child-refresh-hash', CURRENT_TIMESTAMP + INTERVAL '1 day');

INSERT INTO "telegram_link_tokens" ("token", "kind", "userId", "expiresAt")
VALUES
  ('synthetic-parent-link', 'PRIVATE', 'legacy_parent_only', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('synthetic-child-link', 'GROUP', 'legacy_child_no_access', CURRENT_TIMESTAMP + INTERVAL '1 day');

INSERT INTO "telegram_notifications" ("id", "chatId", "type", "entityId", "text", "telegramMessageId", "sentAt", "updatedAt")
VALUES
  ('legacy_queued_notification', '90001', 'LESSON_REPORT', 'synthetic-legacy-report', 'synthetic queued fixture', NULL, NULL, CURRENT_TIMESTAMP),
  ('legacy_sent_notification', '90001', 'LESSON_REPORT', 'synthetic-legacy-report', 'synthetic delivered fixture', 42, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "parent_profiles") <> 2
     OR (SELECT COUNT(*) FROM "student_profiles" WHERE "parentId" IS NOT NULL) <> 2
     OR (SELECT COUNT(*) FROM "teacher_profiles" WHERE "userId" = 'legacy_parent_staff_teacher') <> 1 THEN
    RAISE EXCEPTION 'Legacy multi-profile migration fixture could not be read';
  END IF;
END $$;

COMMIT;
