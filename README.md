# CodeKids App — Backend

CRM для школы допобразования (кружки/курсы для детей). Ведёт учеников, преподавателей,
расписание, занятия, отчёты по занятиям, баланс каждого ученика и выплаты преподавателям.

Роли: `ADMIN`, `MANAGER`, `TEACHER`, `STUDENT`. Роль пользователя определяется
наличием ролевого профиля (`TeacherProfile` / `StudentProfile`) +
опциональным `staffRoles` для ADMIN/MANAGER — см. `prisma/user.prisma`.

Один ученик имеет один независимый кабинет и баланс. Все контакты хранятся у
пользователя в `contacts`, включая контакты родителя или представителя; одинаковые
контакты и Telegram не объединяют кабинеты. Уникальный `login` используется для
входа. Ученика можно создать без логина и пароля, затем выдать доступ парой
`login/password`; `{login: null, password: null}` отзывает его.

## Стек

- **NestJS 11** (Express platform)
- **Prisma 7** с `@prisma/adapter-pg` (driver adapter, без нативного `prisma-client-js` рантайма) — клиент генерируется в `src/generated/`
- **PostgreSQL** (прод — Neon)
- **JWT** (`@nestjs/jwt`) — access-токен в payload, refresh-токен ротируется и хранится в БД (хэш sha256, таблица `refresh_tokens`)
- **nestjs-cls** — request-scoped контекст, используется `AuditService` чтобы достать актора без прокидывания через каждый слой
- **@nestjs/schedule** — cron генерации занятий и Telegram-событий в бизнес-зоне
- **@nestjs/throttler** — общий лимит PostgreSQL: 100 req/min, `/auth/login` — 5/min, `/auth/refresh` — 10/min
- **@sentry/nestjs** — мониторинг ошибок
- **class-validator / class-transformer** — валидация DTO
- **Jest + ts-jest** — unit-тесты и PostgreSQL integration-тесты критичных бизнес-сценариев

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
BUSINESS_TIMEZONE=Europe/Moscow # бизнес-дни и cron; зона расписания остаётся у шаблона
TRUSTED_PROXIES=           # доверенные IP/CIDR через запятую; пусто, если прокси нет
TELEGRAM_BOT_TOKEN=        # необязателен локально
TELEGRAM_WEBHOOK_URL=      # production webhook; при пустом URL локально используется polling
TELEGRAM_WEBHOOK_SECRET=   # обязателен вместе с webhook URL
APP_URL=                   # ссылка на кабинет в Telegram-сообщениях
```

### Миграции и генерация клиента

```bash
pnpm exec prisma generate       # сгенерировать клиент в src/generated
pnpm exec prisma migrate dev    # прогнать миграции локально (создаст новую при изменении схемы)
pnpm exec prisma db seed        # прогнать prisma/seed.ts (использует tsx, настроено в prisma.config.ts)
```

Seed идемпотентно добавляет справочник курсов. Если в базе ещё нет ADMIN, он создаёт
его из `SEED_ADMIN_LOGIN` и `SEED_ADMIN_PASSWORD`; пароль не имеет значения по умолчанию.
Не запускайте seed с production `DATABASE_URL` для локальной настройки.

Схема Prisma разбита на файлы в `prisma/`: `user.prisma`, `course.prisma`,
`lesson.prisma`, `payment.prisma`, `audit.prisma`, `telegram.prisma` и
`throttling.prisma`. Это multi-file schema Prisma 7; `prisma/schema.prisma`
содержит только `generator` и `datasource`.

### Запуск

```bash
pnpm dev     # nest start --watch
pnpm debug   # + node --inspect
pnpm start   # без watch
pnpm prod    # node dist/main, после pnpm build
```

API поднимается на `PORT` (по умолчанию 3000) с префиксом `/api`.
`GET /api/check` — liveness без проверки зависимостей; `GET /api/ready` проверяет
PostgreSQL и возвращает optional-состояние Telegram. Списки используют `page` и
`limit` (по умолчанию 1 и 20, максимум 100); список занятий требует `dateFrom` и
`dateTo` в формате `YYYY-MM-DD` и ограничивает интервал 93 днями.

Локально `prisma migrate dev` создаёт и применяет новую миграцию. В Docker перед
запуском API выполняется `prisma migrate deploy`, которая применяет только ожидающие
миграции из репозитория. Не редактируйте уже применённые миграции и не используйте
`migrate reset` для upgrade-проверки: runner создаёт отдельную временную базу.

## Скрипты

| Команда                 | Что делает                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm build`            | `nest build` → `dist/`                                                                          |
| `pnpm dev`              | dev-сервер с watch                                                                              |
| `pnpm lint`             | eslint --fix по `src`, `apps`, `libs`, `test`                                                   |
| `pnpm format`           | prettier --write                                                                                |
| `pnpm test`             | юнит-тесты (jest, `rootDir: src`, файлы `*.spec.ts`)                                            |
| `pnpm test:cov`         | тесты с coverage                                                                                |
| `pnpm test:e2e`         | Jest config `test/jest-e2e.json`; готовых browser e2e-сценариев сейчас нет                      |
| `pnpm test:integration` | отдельный временный PostgreSQL 17, миграции, drift check и интеграционные тесты; требует Docker |

## Структура проекта

```
src/
  main.ts                  # bootstrap: глобальный prefix /api, CORS, helmet
  instrument.ts             # Sentry.init(), загружается до bootstrap
  app.module.ts              # сборка всех модулей
  health.controller.ts        # GET /api/check и /api/ready
  generated/                 # Prisma client (генерируется, не редактировать руками)
  modules/
    common/
      auth/                  # login/refresh/logout, JwtAuthGuard + RolesGuard как APP_GUARD
      prisma/                # PrismaService (обёртка над PrismaClient + adapter-pg)
      audit/                 # AuditLog — читает актора из CLS-контекста запроса
      business-time.ts       # бизнес-таймзона, фильтр дат и trusted proxies
      pagination.ts          # ограниченные страницы ответов
      throttling/            # общий rate limit через PostgreSQL
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
  seed.ts                     # курсы и необязательный bootstrap ADMIN
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

Ручное пополнение ученика доступно ADMIN/MANAGER в его профиле. `POST /api/users/{studentId}/payments` атомарно сохраняет Payment, положительный
MANUAL_TOPUP в ledger, новый Decimal-баланс и обязательный audit log. Учитель
видит расчёты выплат на странице выплат; ADMIN/MANAGER могут рассчитать их за
закрытый период после окончания бонусных окон.

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
`--stage5` проверяет миграции и drift, а затем запускает тест общего PostgreSQL
throttling.
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

Пагинация, диапазоны дат, бизнес-таймзона, readiness и общий throttling реплик входят
в текущую реализацию. Установки с нуля и upgrade проверяются отдельным изолированным
runner из раздела «Проверки миграций».

## Деплой

- **Railway**, сборка через `Dockerfile` (multi-stage: build → prune prod deps → runner на `node:22-alpine`)
- Контейнер перед запуском приложения выполняет `prisma migrate deploy` (см. `CMD` в Dockerfile). Применённые миграции не редактировать; выпуск с миграциями проверять upgrade-runner-ом на изолированной копии нужного baseline.
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
