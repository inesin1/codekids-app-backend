# Backend integration tests

Run `bash test/run-integration.sh` from the backend repository (or
`pnpm test:integration` with the configured pnpm version). The runner requires a
working local Docker daemon and the PostgreSQL 17 Alpine image. It starts a
uniquely named container with a random password, binds a random port to
`127.0.0.1`, deploys migrations into an empty database, and removes the
container on exit.

The default `--current` mode runs every PostgreSQL integration test against a
fresh install. `--upgrade` applies the historical migrations and fixture,
applies all current migrations, checks the transferred data, and runs the same
integration suite. Both modes compare the resulting database with the Prisma
schema. The Telegram queue suite also launches independent Node worker
processes: one claims a row and is killed before ACK, then a second reclaims
the row after the test expires its lease in PostgreSQL and delivers through a
stub Telegram API.

Other modes:

- `--stage5` checks all current migrations and Prisma drift, then runs the
  shared PostgreSQL throttling concurrency test.
- `--historical` applies migrations through
  `20260921130000_user_birth_dates`.
- `--legacy-fixture` applies that historical set and validates the synthetic
  multi-profile parent/staff and child fixture without applying newer
  migrations.
- `--ambiguous-upgrade` asserts that a parent linked to multiple students
  makes the upgrade fail without changing the legacy schema or data.
- `--inconsistent-enrollment-upgrade` asserts that historical participant
  mismatches reject the composite-FK migration without partially replacing
  constraints.

The two negative upgrade modes skip current-schema Jest tests and drift
checks. Historical and legacy-fixture modes also skip Jest because the current
Prisma client may represent a newer schema.

The runner discards inherited PostgreSQL connection variables and creates
`DATABASE_URL` from its container's loopback port. The runner and Jest setup
validate the database name, user, host, port, schema, and runner guard before
connecting. Telegram credentials and webhook settings are cleared; tests do
not start the application or call Telegram. The integration Prisma config
does not load a `.env` file.
