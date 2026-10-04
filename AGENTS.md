# CodeKids Platform backend instructions

## Stack and structure

Use the existing NestJS module and service patterns, PostgreSQL, and Prisma. Domain modules are under `src/modules/core`; shared auth, Prisma, audit, and validation code is under `src/modules/common`. Keep controllers focused on HTTP and DTO concerns, and put domain behavior in the existing service layer using `PrismaService`.

The Prisma schema is multi-file under `prisma/`; the generated client is under `src/generated`. Edit schema sources and migrations, not generated client output.

## Authorization

Backend authorization is authoritative. Global JWT and role guards are registered through `APP_GUARD`; follow existing decorators and service-level ownership checks for every protected read or mutation. Verify authenticated identity, role, ownership or scope, and resource state. Never trust role or ownership values supplied only by the request.

The current schema represents `TEACHER`, `PARENT`, and `STUDENT` through role profiles, and `ADMIN` / `MANAGER` through `User.staffRoles`. Preserve this model and existing access semantics unless the task explicitly changes them.

## Domain integrity

Before changing enrollment, schedule, lesson, report, or rescheduling behavior, trace the related services, schema, and tests. Preserve history and existing state transitions. Schedule templates store an IANA timezone (currently defaulting to `Europe/Moscow`); lesson slots use local `HH:mm` values and generated lessons store `scheduledAt`. Follow existing timezone, recurrence, conflict, cancellation, and rescheduling behavior.

Paid lesson completion currently couples the lesson update, parent balance change, and transaction record in a database transaction, and stores lesson price/rate snapshots. Preserve atomicity and snapshot semantics when changing this path. Reschedule approval also applies the request and lesson change atomically. Do not infer new accounting, report, or payout rules; trace current services and tests first.

## Money and persistence

Financial values use Prisma `Decimal` and PostgreSQL decimal columns. Preserve precision and current currency semantics; use decimal arithmetic for persisted calculations. Payments and transactions are ledger records, while payouts store period totals and status. Do not silently recalculate historical records.

Never edit an already-applied migration. For schema changes, add a migration, inspect its SQL for data preservation and unintended destructive operations, and validate against PostgreSQL when correctness depends on constraints, transactions, or SQL behavior.

## Errors, tests, and deployment

Use existing exception and validation conventions. Preserve Sentry integration and avoid logging full request bodies or sensitive student, parent, payment, and credential data.

Keep the existing Jest suite and add focused regression coverage for changed authorization, enrollment, scheduling, lesson/report, payment, payout, and calculation behavior. Use PostgreSQL-backed verification when database semantics matter; do not replace those guarantees with weak mocks.

The service deploys through Docker on Railway with PostgreSQL on Neon. Preserve environment-based configuration and the existing Prisma migration/deployment flow; do not hardcode deployment URLs or credentials or rely on local-only runtime behavior.
