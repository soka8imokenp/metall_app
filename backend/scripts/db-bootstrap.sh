#!/usr/bin/env bash
# Создаёт прикладные роли в контейнере metall-asia-postgres. Идемпотентен.
#
# Почему с хоста, а не через /docker-entrypoint-initdb.d: init-скрипты образа
# выполняются от пользователя postgres (uid 999), а файлы секретов лежат с
# правами 600 у владельца хоста — контейнер их прочитать не может и падает с
# «Permission denied». Ослаблять права на секреты нельзя, поэтому SQL
# формируется на хосте и уходит в psql через stdin.
#
# Пароли не попадают ни в docker-compose.yml, ни в git, ни в argv процесса:
# временный SQL-файл создаётся с правами 600 и удаляется в trap.
#
# Роли (обе NOSUPERUSER — суперпользователь обходит RLS молча):
#   metall_owner — владелец схемы, от него накатываются миграции Prisma
#   metall_app   — роль приложения в рантайме, таблицами не владеет,
#                  поэтому политики RLS применяются к ней без оговорок
set -euo pipefail

SECRETS="${HOME}/.local/state/openclaw/secrets"
DB=metall_asia
CONTAINER=metall-asia-postgres

for f in metall-asia-pg-owner metall-asia-pg-app; do
  [ -r "${SECRETS}/${f}" ] || { echo "нет файла секрета ${SECRETS}/${f}" >&2; exit 1; }
done

OWNER_PW="$(cat "${SECRETS}/metall-asia-pg-owner")"
APP_PW="$(cat "${SECRETS}/metall-asia-pg-app")"

SQL_FILE="$(mktemp)"
chmod 600 "${SQL_FILE}"
trap 'rm -f "${SQL_FILE}"' EXIT

cat > "${SQL_FILE}" <<SQL
DO \$do\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metall_owner') THEN
    EXECUTE format('ALTER ROLE metall_owner PASSWORD %L', \$pw\$${OWNER_PW}\$pw\$);
  ELSE
    EXECUTE format('CREATE ROLE metall_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', \$pw\$${OWNER_PW}\$pw\$);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metall_app') THEN
    EXECUTE format('ALTER ROLE metall_app PASSWORD %L', \$pw\$${APP_PW}\$pw\$);
  ELSE
    EXECUTE format('CREATE ROLE metall_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', \$pw\$${APP_PW}\$pw\$);
  END IF;
END
\$do\$;

-- BYPASSRLS только владельцу схемы: им ходят миграции и сид, где строки
-- создаются до того, как известен company_id контекста. Рабочая роль
-- metall_app его не получает — на ней RLS проверяется по-настоящему.
-- Работающий сервис ролью владельца не ходит вовсе, включая вход в систему:
-- см. 02-ARCHITECTURE.md §4.4 и миграцию auth_without_bypassrls.
ALTER ROLE metall_owner BYPASSRLS;
ALTER ROLE metall_app NOBYPASSRLS;

ALTER DATABASE ${DB} OWNER TO metall_owner;

-- Публичную схему пересоздаём от владельца: с PostgreSQL 15 её владелец —
-- pg_database_owner, и прав на CREATE у metall_owner по умолчанию нет.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public AUTHORIZATION metall_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO metall_app;

-- Таблицы создаёт metall_owner миграциями, поэтому права приложению выдаём
-- правилом по умолчанию, а не разовым GRANT после каждой миграции.
ALTER DEFAULT PRIVILEGES FOR ROLE metall_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO metall_app;
ALTER DEFAULT PRIVILEGES FOR ROLE metall_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO metall_app;
SQL

docker exec -i "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U postgres -d "${DB}" -q < "${SQL_FILE}"

# Теневая база для prisma migrate. Prisma заводит её сама, но только если у роли
# есть CREATEDB — а его нет намеренно. Поэтому создаём здесь один раз, а путь к
# ней отдаём через SHADOW_DATABASE_URL.
if ! docker exec "${CONTAINER}" psql -U postgres -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname = '${DB}_shadow'" | grep -q 1; then
  docker exec "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q \
    -c "CREATE DATABASE ${DB}_shadow OWNER metall_owner"
fi
docker exec "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U postgres -d "${DB}_shadow" -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION metall_owner;"

echo "роли metall_owner и metall_app готовы, схема public принадлежит metall_owner"
echo "теневая база ${DB}_shadow готова"
