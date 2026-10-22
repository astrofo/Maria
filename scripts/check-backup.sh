#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
if [[ $# -ne 1 || ! -f "$1" ]]; then
  printf 'Использование: bash scripts/check-backup.sh /путь/к/portal.dump\n' >&2
  exit 1
fi
PORTAL_RESTORE_DATABASE="portal_restore_$(date -u '+%Y%m%d%H%M%S')_$$"
PORTAL_RESTORE_CREATED=false
PORTAL_RESTORE_REMOVED=false
portal_restore_exit() {
  local result=$?
  if [[ "$PORTAL_RESTORE_CREATED" == true && "$PORTAL_RESTORE_REMOVED" != true ]]; then
    printf 'Проверочная база %s сохранена для диагностики. Рабочая база не изменена.\n' "$PORTAL_RESTORE_DATABASE" >&2
    printf 'После разбора ошибки удалите только эту базу с указанным точным именем.\n' >&2
  fi
  return "$result"
}
trap portal_restore_exit EXIT
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db sh -c 'createdb -U "$POSTGRES_USER" -T template0 "$1"' sh "$PORTAL_RESTORE_DATABASE"
PORTAL_RESTORE_CREATED=true
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db sh -c 'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$1"' sh "$PORTAL_RESTORE_DATABASE" < "$1"
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS participation_records FROM participation;"' sh "$PORTAL_RESTORE_DATABASE"
[[ "$PORTAL_RESTORE_DATABASE" =~ ^portal_restore_[0-9]{14}_[0-9]+$ ]] || exit 1
# Only remove the database created by this invocation, never the application's DB.
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db sh -c 'test "$1" != "$POSTGRES_DB" && dropdb -U "$POSTGRES_USER" -- "$1"' sh "$PORTAL_RESTORE_DATABASE"
PORTAL_RESTORE_REMOVED=true
printf 'Копия восстановлена; проверочная база %s после успешной проверки удалена. Рабочая база не изменена.\n' "$PORTAL_RESTORE_DATABASE"
