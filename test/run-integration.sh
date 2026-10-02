#!/usr/bin/env bash
set -euo pipefail

backend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$backend_root"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the isolated PostgreSQL integration tests.' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo 'Cannot access the local Docker daemon.' >&2
  exit 1
fi

unset DATABASE_URL PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE
unset CODEKIDS_IT_MIGRATIONS CODEKIDS_IT_CONTAINER CODEKIDS_IT_DB_GUARD

db_name='codekids_integration'
db_user='codekids_test'
db_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
container_name="codekids-it-${UID:-0}-$$-${RANDOM}"
container_id=''
temp_dir=''

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$temp_dir" ]]; then
    rm -rf "$temp_dir"
  fi
}
trap cleanup EXIT

migrations_path="$backend_root/prisma/migrations"
integration_mode="${1:---current}"
case "$integration_mode" in
  --current) ;;
  --historical|--legacy-fixture|--upgrade|--ambiguous-upgrade|--inconsistent-enrollment-upgrade)
    baseline_migration='20260921130000_user_birth_dates'
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codekids-integration.XXXXXX")"
    mkdir -p "$temp_dir/migrations"
    while IFS= read -r migration_path; do
      migration_name="$(basename "$migration_path")"
      if [[ "$migration_name" > "$baseline_migration" ]]; then
        break
      fi
      cp -R "$migration_path" "$temp_dir/migrations/$migration_name"
    done < <(find "$migrations_path" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
    cp "$migrations_path/migration_lock.toml" "$temp_dir/migrations/migration_lock.toml"
    if [[ ! -d "$temp_dir/migrations/$baseline_migration" ]]; then
      echo "Historical migration $baseline_migration is missing." >&2
      exit 1
    fi
    migrations_path="$temp_dir/migrations"
    ;;
  *)
    echo 'Usage: test:integration [--current|--historical|--legacy-fixture|--upgrade|--ambiguous-upgrade|--inconsistent-enrollment-upgrade]' >&2
    exit 2
    ;;
esac

container_id="$(docker run --detach --rm \
  --name "$container_name" \
  --label 'codekids.integration=true' \
  --env "POSTGRES_DB=$db_name" \
  --env "POSTGRES_USER=$db_user" \
  --env "POSTGRES_PASSWORD=$db_password" \
  --publish '127.0.0.1::5432' \
  postgres:17-alpine)"

attempt=0
until docker exec "$container_id" pg_isready --quiet --username="$db_user" --dbname="$db_name"; do
  attempt=$((attempt + 1))
  if (( attempt >= 60 )); then
    echo 'Timed out waiting for the isolated PostgreSQL container.' >&2
    exit 1
  fi
  sleep 1
done

port_mapping="$(docker port "$container_id" 5432/tcp)"
if [[ "$port_mapping" != 127.0.0.1:* ]]; then
  echo 'The integration database is not bound to loopback.' >&2
  exit 1
fi
db_port="${port_mapping##*:}"
if [[ ! "$db_port" =~ ^[0-9]+$ ]] || (( db_port < 1 || db_port > 65535 )); then
  echo 'Docker returned an invalid integration database port.' >&2
  exit 1
fi

export DATABASE_URL="postgresql://${db_user}:${db_password}@127.0.0.1:${db_port}/${db_name}?schema=public"
export CODEKIDS_IT_CONTAINER="$container_name"
export CODEKIDS_IT_DB_GUARD="${container_name}/${db_name}"
export CODEKIDS_IT_MIGRATIONS="$migrations_path"
export NODE_ENV='test'
export TELEGRAM_BOT_TOKEN=''
export TELEGRAM_WEBHOOK_URL=''
export TELEGRAM_WEBHOOK_SECRET=''

node ./test/assert-integration-database.cjs

./node_modules/.bin/prisma migrate deploy --config ./test/prisma.integration.config.ts
if [[ "$integration_mode" == '--upgrade' || "$integration_mode" == '--legacy-fixture' || "$integration_mode" == '--inconsistent-enrollment-upgrade' ]]; then
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/legacy-multi-profile.sql
fi

if [[ "$integration_mode" == '--inconsistent-enrollment-upgrade' ]]; then
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/legacy-inconsistent-enrollment.sql
fi

if [[ "$integration_mode" == '--ambiguous-upgrade' ]]; then
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/legacy-ambiguous-parent.sql
fi

if [[ "$integration_mode" == '--inconsistent-enrollment-upgrade' ]]; then
  migrations_path="$backend_root/prisma/migrations"
  export CODEKIDS_IT_MIGRATIONS="$migrations_path"
  if ./node_modules/.bin/prisma migrate deploy --config ./test/prisma.integration.config.ts; then
    echo 'Inconsistent enrollment migration unexpectedly succeeded.' >&2
    exit 1
  fi
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/assert-inconsistent-enrollment-rollback.sql
  exit 0
fi

if [[ "$integration_mode" == '--legacy-fixture' ]]; then
  exit 0
fi

if [[ "$integration_mode" == '--upgrade' ]]; then
  migrations_path="$backend_root/prisma/migrations"
  export CODEKIDS_IT_MIGRATIONS="$migrations_path"
  ./node_modules/.bin/prisma migrate deploy --config ./test/prisma.integration.config.ts
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/assert-student-portal-upgrade.sql
fi

if [[ "$integration_mode" == '--ambiguous-upgrade' ]]; then
  migrations_path="$backend_root/prisma/migrations"
  export CODEKIDS_IT_MIGRATIONS="$migrations_path"
  if ./node_modules/.bin/prisma migrate deploy --config ./test/prisma.integration.config.ts; then
    echo 'Ambiguous student migration unexpectedly succeeded.' >&2
    exit 1
  fi
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/assert-ambiguous-migration-rollback.sql
fi

if [[ "$integration_mode" != '--ambiguous-upgrade' ]]; then
  docker exec -i "$container_id" psql --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" < test/fixtures/postgres-smoke.sql
fi

if [[ "$integration_mode" == '--current' || "$integration_mode" == '--upgrade' ]]; then
  ./node_modules/.bin/prisma migrate diff --config ./test/prisma.integration.config.ts \
    --from-config-datasource --to-schema ./prisma --exit-code
fi

if [[ "$integration_mode" == '--current' || "$integration_mode" == '--upgrade' ]] && [[ -d test/integration ]] && find test/integration -type f -name '*.integration.spec.ts' -print -quit | grep -q .; then
  ./node_modules/.bin/prisma generate --config ./test/prisma.integration.config.ts
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-vm-modules" ./node_modules/.bin/jest --config ./test/jest-integration.json --runInBand
fi
