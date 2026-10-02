INSERT INTO "users" ("id", "email", "password", "firstName", "lastName", "staffRoles", "updatedAt")
VALUES ('ambiguous_parent', 'ambiguous@example.test', 'synthetic-hash', 'Ambiguous', 'Parent', ARRAY[]::"Role"[], CURRENT_TIMESTAMP);

INSERT INTO "parent_profiles" ("userId", "balance", "updatedAt")
VALUES ('ambiguous_parent', 25.00, CURRENT_TIMESTAMP);

INSERT INTO "users" ("id", "firstName", "lastName", "staffRoles", "updatedAt")
VALUES
  ('ambiguous_child_one', 'Child', 'One', ARRAY[]::"Role"[], CURRENT_TIMESTAMP),
  ('ambiguous_child_two', 'Child', 'Two', ARRAY[]::"Role"[], CURRENT_TIMESTAMP);

INSERT INTO "student_profiles" ("userId", "parentId", "updatedAt")
VALUES
  ('ambiguous_child_one', 'ambiguous_parent', CURRENT_TIMESTAMP),
  ('ambiguous_child_two', 'ambiguous_parent', CURRENT_TIMESTAMP);
