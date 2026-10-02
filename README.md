# CodeKids App — Backend

CRM для школы допобразования (кружки/курсы для детей). Ведёт учеников, преподавателей,
расписание, занятия, отчёты по занятиям, баланс каждого ученика и выплаты преподавателям.

Роли: `ADMIN`, `MANAGER`, `TEACHER`, `STUDENT`. Роль пользователя определяется
наличием ролевого профиля (`TeacherProfile` / `StudentProfile`) +
опциональным `staffRoles` для ADMIN/MANAGER — см. `prisma/user.prisma`.

Один ученик имеет один независимый кабинет и баланс. Родительские контакты хранятся
в StudentProfile; одинаковые email и Telegram не объединяют кабинеты. Уникальный
`login` отделён от контактного email. Ученика можно создать без логина и пароля,
затем выдать доступ парой `login/password`; `{login: null, password: null}` отзывает его.

## Стек

- **NestJS 11** (Express platform)
- **Prisma 7** с `@prisma/adapter-pg` (driver adapter, без нативного `prisma-client-js` рантайма) — клиент генерируется в `src/generated/`
- **PostgreSQL** (прод — Neon)
- **JWT** (`@nestjs/jwt`) — access-токен в payload, refresh-токен ротируется и хранится в БД (хэш sha256, таблица `refresh_tokens`)
- **nestjs-cls** — request-scoped контекст, используется `AuditService` чтобы достать актора без прокидывания через каждый слой
- **@nestjs/schedule** — крон автогенерации занятий по расписанию (`EVERY_DAY_AT_3AM`)
- **@nestjs/throttler** — rate limit (глобально 100 req/min, `/auth/login` — 5/min, `/auth/refresh` — 10/min)
- **@sentry/nestjs** — мониторинг ошибок
- **class-validator / class-transformer** — валидация DTO
- **Jest + ts-jest** — юнит-тесты (минимальный набор на критичную логику: auth, генерация занятий, начисления)

## Локальный запуск

### Требования

- Node.js 22 (см. CI/Dockerfile)
- pnpm версии из `packageManager` в `package.json`
- PostgreSQL (локально или Neon-ветка)

### Установка

```bash
pnpm install
```

### Переменные окружения

Скопировать `.env.example` → `.env` и заполнить:

```bash
DATABASE_URL=            # postgres connection string
JWT_SECRET=               # openssl rand -hex 32
JWT_ACCESS_TTL="15m"
JWT_REFRESH_TTL="30d"
BONUS_AMOUNT="50"          # премия преподавателю за отчёт по занятию, отправленный вовремя
BONUS_WINDOW_HOURS="24"    # окно, в течение которого отчёт считается «быстрым»
SENTRY_DSN=                # пусто локально — Sentry молчит и не шлёт dev-ошибки в прод-проект
```

### Миграции и генерация клиента

```bash
pnpm exec prisma generate       # сгенерировать клиент в src/generated
pnpm exec prisma migrate dev    # прогнать миграции локально (создаст новую при изменении схемы)
pnpm exec prisma db seed        # прогнать prisma/seed.ts (использует tsx, настроено в prisma.config.ts)
```

Схема Prisma разбита на несколько файлов в `prisma/` (`user.prisma`, `course.prisma`,
`lesson.prisma`, `payment.prisma`, `audit.prisma`, `telegram.prisma`) — это multi-file schema
Prisma 7, `prisma/schema.prisma` содержит только `generator`/`datasource`.

### Запуск

```bash
pnpm dev     # nest start --watch
pnpm debug   # + node --inspect
pnpm start   # без watch
pnpm prod    # node dist/main, после pnpm build
```

API поднимается на `PORT` (по умолчанию 3000) с префиксом `/api`. Health-check: `GET /api/check`.

## Скрипты

| Команда | Что делает |
|---|---|
| `pnpm build` | `nest build` → `dist/` |
| `pnpm dev` | dev-сервер с watch |
| `pnpm lint` | eslint --fix по `src`, `apps`, `libs`, `test` |
| `pnpm format` | prettier --write |
| `pnpm test` | юнит-тесты (jest, `rootDir: src`, файлы `*.spec.ts`) |
| `pnpm test:cov` | тесты с coverage |
| `pnpm test:e2e` | e2e (`test/jest-e2e.json`) |
| `pnpm test:integration` | отдельный временный PostgreSQL 17, миграции, drift check и интеграционные тесты; требует Docker |

## Структура проекта

```
src/
  main.ts                  # bootstrap: глобальный prefix /api, CORS, helmet
  instrument.ts             # Sentry.init(), импортируется первым в main.ts
  app.module.ts              # сборка всех модулей
  health.controller.ts        # GET /api/check
  generated/                 # Prisma client (генерируется, не редактировать руками)
  modules/
    common/
      auth/                  # login/refresh/logout, JwtAuthGuard + RolesGuard как APP_GUARD
      prisma/                # PrismaService (обёртка над PrismaClient + adapter-pg)
      audit/                 # AuditLog — читает актора из CLS-контекста запроса
      validation/             # ValidationPipe konfig + кастомные исключения
    core/
      users/                 # пользователи, ролевые профили
      courses/                # справочник направлений
      enrollments/            # связка teacher–student–course, индивидуальные ставки/цены
      lessons/                # расписание (ScheduleTemplate), занятия, отчёты, материалы,
                                # заявки на перенос/отмену, автогенерация по крону
      payouts/                # выплаты преподавателям
prisma/
  *.prisma                    # схема (multi-file), см. выше
  migrations/                  # SQL-миграции
  seed.ts                      # dev-сиды
```

## Авторизация

- `POST /api/auth/login` — login+password → `{ accessToken, refreshToken, user }`
- `POST /api/auth/refresh` — атомарно обменивает refresh-токен на новую пару; конкурентный повтор отклоняется, ошибка выпуска новой пары откатывает потребление старой
- `POST /api/auth/logout` — удаляет refresh-токен из БД
- `JwtAuthGuard` глобальный (`APP_GUARD`), эндпоинты открываются декоратором `@Public()`
- Guard проверяет активность, `securityVersion` и роли по актуальному User; JWT не сохраняет отозванные права
- Изменение доступа, пароля и staff-прав увеличивает `securityVersion` и отзывает refresh-сессии в той же транзакции
- Refresh-токен хранится в БД только в виде sha256-хэша, сам токен — 32 случайных байта (hex)

## Финансовые операции

Завершение занятия блокирует профиль преподавателя, затем ученика и условно переводит
SCHEDULED в COMPLETED. Decimal-списание и баланс, аудит и финансовый снимок сохраняются
одной транзакцией. Цена и ставка проведённого занятия неизменяемы. Перенос копирует
индивидуальные суммы, включая нулевую стоимость пробного урока.

Выплаты используют закрытые интервалы `[periodStart, periodEnd)`. Расчёт блокирует
преподавателя и допускается после окончания бонусных окон всех включённых занятий.
Пересекающиеся периоды запрещены; PAID и paidAt не меняются при повторе. Увеличение
BONUS_WINDOW_HOURS не добавляет бонус в уже финализированную выплату.

## Проверки миграций

`bash test/run-integration.sh --current` применяет все миграции с нуля, сравнивает
полученную БД со схемой Prisma и запускает сервисные тесты. `--upgrade` сначала
создаёт прежнюю схему с минимальными фикстурами, затем проверяет переход и те же тесты.
`--ambiguous-upgrade` проверяет отказ и rollback при неоднозначных старых данных.
`--inconsistent-enrollment-upgrade` проверяет отказ составных FK на прежних
несогласованных участниках, сохранение данных и отсутствие частично применённой DDL.
Подробности и дополнительные режимы — [test/README.md](test/README.md).

Runner создаёт собственный контейнер на случайном loopback-порту и удаляет его после
прогона. Он не использует рабочую DATABASE_URL и отключает реальные Telegram-вызовы.
Миграции не сбрасывают данные автоматически: неоднозначные связи или несовпадающие
участники Enrollment останавливают переход. Проверяйте upgrade на копии перед выпуском.

## Telegram

Обязательные события сохраняются вместе с бизнес-операцией, даже когда бот временно
не инициализирован. Исходящее задание принадлежит конкретному пользователю или группе
ученика и версии привязки. Повтор producer не создаёт копию; изменение текста повышает
desiredVersion. Перепривязка и unlink отменяют старые задания, новая привязка получает
отдельный Telegram message ID. Старые неотправленные задания без однозначного адресата
отменяются миграцией; история доставленных сообщений сохраняется.

Воркеры захватывают задания короткой транзакцией с SKIP LOCKED и lease. Telegram API
вызывается вне транзакций. Истёкший lease восстанавливается, временные ошибки повторяются
с задержкой, 429 учитывает retry_after, постоянные ошибки завершают задание. Доставка
at-least-once: сбой между внешней отправкой и сохранением результата может создать повтор.

`POST /api/telegram/webhook` проверяет секрет и сохраняет unique update_id до успешного
ответа. Ошибка БД не подтверждает update; inbox затем обрабатывается с повторами.
Одноразовая ссылка потребляется вместе с изменением привязки в одной транзакции.
Production и несколько реплик используют webhook. Polling предназначен для одного
локального процесса и сохраняет updates до продвижения offset; в production он выключен.

`GET /api/telegram/queue-health` доступен ADMIN/MANAGER и возвращает только агрегаты:
pending, failed, leased, expiredLease, oldestPendingAt, pendingInbox, failedInbox,
leasedInbox. Ошибки очереди не включают содержимое сообщений или данные пользователей.

Ограниченная пагинация, единая бизнес-зона, readiness и общий throttling реплик относятся
к следующему этапу IMPLEMENTATION-PLAN и ещё не завершены.

## Деплой

- **Railway**, сборка через `Dockerfile` (multi-stage: build → prune prod deps → runner на `node:22-alpine`)
- Контейнер на старте гонит `prisma migrate deploy` и только потом стартует `node dist/main` (см. `CMD` в Dockerfile) — миграции применяются автоматически при каждом деплое, ручного шага нет
- БД — Neon (Postgres), `DATABASE_URL` передаётся через переменные окружения Railway
- Порт берётся из `process.env.PORT` (Railway подставляет сам)
- Ошибки летят в Sentry, если задан `SENTRY_DSN`

## CI

`.github/workflows/ci.yml`, триггер — push/PR в `main`:

```
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec eslint "{src,apps,libs,test}/**/*.ts"
pnpm run test
pnpm run build
```

Миграции в CI не гоняются — только генерация клиента (для тайпчека/сборки). Живая БД CI не нужна.
