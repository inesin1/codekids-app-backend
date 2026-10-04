BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "users"
    WHERE "contacts" IS NOT NULL
      AND jsonb_typeof("contacts") <> 'array'
  ) THEN
    RAISE EXCEPTION 'Cannot unify user contacts: contacts must be a JSON array';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "student_profiles"
    WHERE "parentContacts" IS NOT NULL
      AND jsonb_typeof("parentContacts") <> 'array'
  ) THEN
    RAISE EXCEPTION 'Cannot unify user contacts: parentContacts must be a JSON array';
  END IF;
END $$;

UPDATE "users" AS u
SET "contacts" = COALESCE(u."contacts", '[]'::jsonb) || COALESCE((
  SELECT jsonb_agg(parent_contact.item ORDER BY parent_contact.ordinality)
  FROM jsonb_array_elements(sp."parentContacts") WITH ORDINALITY AS parent_contact(item, ordinality)
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(u."contacts", '[]'::jsonb)) AS user_contact(item)
    WHERE lower(COALESCE(user_contact.item ->> 'label', '')) = lower(COALESCE(parent_contact.item ->> 'label', ''))
      AND lower(COALESCE(user_contact.item ->> 'value', '')) = lower(COALESCE(parent_contact.item ->> 'value', ''))
  )
), '[]'::jsonb)
FROM "student_profiles" AS sp
WHERE sp."userId" = u."id"
  AND sp."parentContacts" IS NOT NULL
  AND jsonb_array_length(sp."parentContacts") > 0;

UPDATE "users" AS u
SET "contacts" = COALESCE(u."contacts", '[]'::jsonb) || jsonb_build_array(
  jsonb_build_object('label', 'Email', 'value', BTRIM(u."email"))
)
WHERE NULLIF(BTRIM(u."email"), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(u."contacts", '[]'::jsonb)) AS contact(item)
    WHERE (
      strpos(lower(COALESCE(contact.item ->> 'label', '')), 'mail') > 0
      OR strpos(lower(COALESCE(contact.item ->> 'label', '')), 'почт') > 0
    )
      AND lower(contact.item ->> 'value') = lower(BTRIM(u."email"))
  );

ALTER TABLE "student_profiles" DROP COLUMN "parentContacts";
ALTER TABLE "users" DROP COLUMN "email";

COMMIT;
