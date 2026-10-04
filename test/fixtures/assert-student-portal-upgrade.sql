DO $$
DECLARE
  child_no_access RECORD;
  child_no_access_profile RECORD;
  parent_only RECORD;
  child_with_access RECORD;
  child_with_access_profile RECORD;
  parent_staff RECORD;
BEGIN
  IF to_regclass('public.parent_profiles') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'student_profiles' AND column_name = 'parentId'
     )
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'student_profiles' AND column_name = 'parentContacts'
     )
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('payments', 'transactions') AND column_name = 'parentId'
     ) THEN
    RAISE EXCEPTION 'Obsolete parent profile or parentId schema remains active';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Role' AND e.enumlabel = 'PARENT') THEN
    RAISE EXCEPTION 'PARENT remains in the active Role enum';
  END IF;

  SELECT * INTO child_no_access FROM "users" WHERE "id" = 'legacy_child_no_access';
  SELECT * INTO child_no_access_profile FROM "student_profiles" WHERE "userId" = 'legacy_child_no_access';
  SELECT * INTO parent_only FROM "users" WHERE "id" = 'legacy_parent_only';
  SELECT * INTO child_with_access FROM "users" WHERE "id" = 'legacy_child_with_access';
  SELECT * INTO child_with_access_profile FROM "student_profiles" WHERE "userId" = 'legacy_child_with_access';
  SELECT * INTO parent_staff FROM "users" WHERE "id" = 'legacy_parent_staff_teacher';

  IF child_no_access."login" <> 'parent-only@example.test'
     OR child_no_access."password" <> 'legacy-parent-hash'
     OR child_no_access."telegramChatId" <> '90001'
     OR child_no_access."securityVersion" <> 1 THEN
    RAISE EXCEPTION 'Parent-only credentials or Telegram identity did not transfer to the child';
  END IF;

  IF parent_only."login" IS NOT NULL OR parent_only."password" IS NOT NULL
     OR parent_only."telegramChatId" IS NOT NULL OR parent_only."isActive"
     OR parent_only."securityVersion" <> 1 THEN
    RAISE EXCEPTION 'Parent-only user was not retained in an inactive, revoked state';
  END IF;

  IF child_with_access."login" <> 'child-access@example.test'
     OR child_with_access."password" <> 'child-own-hash'
     OR child_with_access."telegramChatId" <> '90003' THEN
    RAISE EXCEPTION 'Existing child credentials or Telegram identity were overwritten';
  END IF;

  IF parent_staff."login" <> 'parent-staff@example.test'
     OR parent_staff."password" <> 'legacy-staff-hash'
     OR parent_staff."telegramChatId" <> '90002' OR NOT parent_staff."isActive"
     OR NOT (parent_staff."staffRoles" @> ARRAY['MANAGER']::"Role"[])
     OR NOT EXISTS (SELECT 1 FROM "teacher_profiles" WHERE "userId" = parent_staff."id") THEN
    RAISE EXCEPTION 'Staff/teacher parent identity or access was changed';
  END IF;

  IF child_no_access."id" <> 'legacy_child_no_access'
     OR child_with_access."id" <> 'legacy_child_with_access'
     OR child_no_access_profile."balance" <> 12.34 OR child_with_access_profile."balance" <> 7.50 THEN
    RAISE EXCEPTION 'Student IDs or migrated balances were not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "student_profiles" AS sp
    JOIN "users" AS u ON u."id" = sp."userId"
    WHERE sp."userId" = child_no_access."id"
      AND sp."parentName" = 'Legacy Parent'
      AND u."contacts" @> '[{"label":"Phone","value":"+10000000001"},{"label":"Email","value":"parent-only@example.test"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'Contacts were not unified on the user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "payments" WHERE "id" = 'legacy_payment' AND "studentId" = 'legacy_child_no_access')
     OR NOT EXISTS (SELECT 1 FROM "transactions" WHERE "id" = 'legacy_transaction' AND "studentId" = 'legacy_child_no_access') THEN
    RAISE EXCEPTION 'Ledger rows were not transferred to the preserved student ID';
  END IF;

  IF EXISTS (SELECT 1 FROM "refresh_tokens") OR EXISTS (SELECT 1 FROM "telegram_link_tokens") THEN
    RAISE EXCEPTION 'Legacy refresh sessions or Telegram links were not revoked';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "telegram_notifications"
    WHERE "id" = 'legacy_queued_notification'
      AND "eventKey" = 'legacy:legacy_queued_notification'
      AND "canceledAt" IS NOT NULL AND "sentAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "telegram_notifications"
    WHERE "id" = 'legacy_sent_notification'
      AND "telegramMessageId" = 42 AND "sentAt" IS NOT NULL
      AND "deliveredVersion" = 1 AND "canceledAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy pending delivery was not canceled or sent history was changed';
  END IF;
END $$;
