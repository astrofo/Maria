#!/usr/bin/env bash
set -euo pipefail
umask 077
PORTAL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${PORTAL_PROJECT_ROOT:-$PORTAL_SCRIPT_DIR/..}"
source "$PORTAL_SCRIPT_DIR/prune-retained-artifacts.sh"
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
PORTAL_BACKUP_DIR="${PORTAL_BACKUP_DIR:-.backups}"
PORTAL_BACKUP_RETENTION_DAYS="${PORTAL_BACKUP_RETENTION_DAYS:-30}"
if [[ "$PORTAL_BACKUP_RETENTION_DAYS" != 30 ]]; then
  printf 'Политика использует 30 дней: последние 7 дней и 4 предыдущие календарные недели.\n' >&2
  exit 1
fi
if [[ "$PORTAL_BACKUP_DIR" == / || -z "$PORTAL_BACKUP_DIR" || -L "$PORTAL_BACKUP_DIR" ]]; then
  printf 'Укажите отдельную обычную папку резервных копий.\n' >&2
  exit 1
fi
mkdir -p -m 700 "$PORTAL_BACKUP_DIR"
[[ ! -L "$PORTAL_BACKUP_DIR/.backup.lock" ]] || exit 1
exec 8>"$PORTAL_BACKUP_DIR/.backup.lock"
flock -w 600 8 || { printf 'Другая резервная копия ещё выполняется.\n' >&2; exit 1; }
if [[ -n "${PORTAL_BACKUP_RELEASE_ID:-}" ]]; then
  portal_release_id "$PORTAL_BACKUP_RELEASE_ID" || exit 1
  portal_managed_release ".releases/$PORTAL_BACKUP_RELEASE_ID" || exit 1
fi

# Parse a fixed allowlist; the optional configuration is never executed as shell.
if [[ -e .backup-offsite.env ]]; then
  [[ -f .backup-offsite.env && ! -L .backup-offsite.env ]] || exit 1
  while IFS= read -r PORTAL_LINE || [[ -n "$PORTAL_LINE" ]]; do
    [[ -z "$PORTAL_LINE" || "$PORTAL_LINE" == \#* ]] && continue
    [[ "$PORTAL_LINE" == *=* ]] || { printf 'Некорректный .backup-offsite.env.\n' >&2; exit 1; }
    PORTAL_KEY="${PORTAL_LINE%%=*}"; PORTAL_VALUE="${PORTAL_LINE#*=}"
    case "$PORTAL_KEY" in
      PORTAL_OFFSITE_HOST|PORTAL_OFFSITE_DIR|PORTAL_OFFSITE_PORT|PORTAL_OFFSITE_IDENTITY)
        if ! declare -p "$PORTAL_KEY" > /dev/null 2>&1; then printf -v "$PORTAL_KEY" '%s' "$PORTAL_VALUE"; fi ;;
      *) printf 'Неизвестный параметр в .backup-offsite.env.\n' >&2; exit 1 ;;
    esac
  done < .backup-offsite.env
fi
PORTAL_OFFSITE_HOST="${PORTAL_OFFSITE_HOST:-}"
if [[ -n "$PORTAL_OFFSITE_HOST" ]]; then
  PORTAL_OFFSITE_DIR="${PORTAL_OFFSITE_DIR:?Set PORTAL_OFFSITE_DIR}"
  PORTAL_OFFSITE_PORT="${PORTAL_OFFSITE_PORT:-22}"
  if [[ ! "$PORTAL_OFFSITE_HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ || ! "$PORTAL_OFFSITE_DIR" =~ ^/[a-zA-Z0-9_./-]+$ || "$PORTAL_OFFSITE_DIR" == / || "$PORTAL_OFFSITE_DIR" == *..* || ! "$PORTAL_OFFSITE_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORTAL_OFFSITE_PORT < 1 || 10#$PORTAL_OFFSITE_PORT > 65535 )); then
    printf 'Проверьте адрес, каталог и порт внешнего хранилища.\n' >&2; exit 1
  fi
  PORTAL_SSH_OPTIONS=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
  if [[ -n "${PORTAL_OFFSITE_IDENTITY:-}" ]]; then
    [[ -f "$PORTAL_OFFSITE_IDENTITY" ]] || { printf 'SSH-ключ хранилища не найден.\n' >&2; exit 1; }
    PORTAL_SSH_OPTIONS+=(-i "$PORTAL_OFFSITE_IDENTITY")
  fi
fi

PORTAL_BACKUP_NAME="portal-$(date -u '+%Y%m%dT%H%M%SZ')-$$.dump"
PORTAL_BACKUP_FILE="$PORTAL_BACKUP_DIR/$PORTAL_BACKUP_NAME"
PORTAL_UPLOADS_NAME="${PORTAL_BACKUP_NAME%.dump}.uploads.tar.gz"
PORTAL_UPLOADS_FILE="$PORTAL_BACKUP_DIR/$PORTAL_UPLOADS_NAME"
[[ ! -e "$PORTAL_BACKUP_FILE" && ! -e "$PORTAL_BACKUP_FILE.partial" && ! -e "$PORTAL_UPLOADS_FILE" && ! -e "$PORTAL_UPLOADS_FILE.partial" ]] || exit 1
trap 'rm -f -- "$PORTAL_BACKUP_FILE.partial" "$PORTAL_UPLOADS_FILE.partial"' EXIT
# Keep durable records, but do not resurrect browser sessions or pending codes
# when a backup is restored. pg_dump still includes these tables' schemas.
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db sh -c 'pg_dump --format=custom --no-owner --no-acl --exclude-table-data=public.sessions --exclude-table-data=public.pending_email_registrations --exclude-table-data=public.pending_login_codes --exclude-table-data=public.password_reset_requests -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$PORTAL_BACKUP_FILE.partial"
test -s "$PORTAL_BACKUP_FILE.partial"
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T db pg_restore --list < "$PORTAL_BACKUP_FILE.partial" > /dev/null
# Uploaded images are immutable, content-addressed files. Taking their archive
# after the database snapshot includes every image referenced by that snapshot.
# A pre-upgrade app may not have this directory yet; all other errors are fatal.
PORTAL_UPLOADS_CREATED=false
PORTAL_UPLOADS_RESULT=0
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T app sh -c '
  directory="${UPLOAD_DIR:-/app/uploads}"
  if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then exit 44; fi
  [ -d "$directory" ] && [ ! -L "$directory" ] && [ -r "$directory" ] && [ -x "$directory" ] || exit 1
  exec tar -czf - -C "$directory" .
' > "$PORTAL_UPLOADS_FILE.partial" || PORTAL_UPLOADS_RESULT=$?
if [[ "$PORTAL_UPLOADS_RESULT" == 44 ]]; then
  rm -- "$PORTAL_UPLOADS_FILE.partial"
  printf 'Каталога загрузок в предыдущем приложении ещё нет; архив изображений не требуется.\n'
elif [[ "$PORTAL_UPLOADS_RESULT" != 0 ]]; then
  printf 'Не удалось сохранить загрузки. Новая копия не завершена; существующие копии сохранены.\n' >&2
  exit 1
else
  test -s "$PORTAL_UPLOADS_FILE.partial"
  tar -tzf "$PORTAL_UPLOADS_FILE.partial" > /dev/null
  mv -- "$PORTAL_UPLOADS_FILE.partial" "$PORTAL_UPLOADS_FILE"
  PORTAL_UPLOADS_CREATED=true
fi
mv -- "$PORTAL_BACKUP_FILE.partial" "$PORTAL_BACKUP_FILE"
printf 'Локальная копия создана и оглавление прочитано: %s\n' "$PORTAL_BACKUP_FILE"
if [[ "$PORTAL_UPLOADS_CREATED" == true ]]; then printf 'Загрузки сохранены рядом с базой: %s\n' "$PORTAL_UPLOADS_FILE"; fi
if [[ -n "${PORTAL_BACKUP_RELEASE_ID:-}" ]]; then
  printf '%s\n' "$PORTAL_BACKUP_NAME" > ".releases/$PORTAL_BACKUP_RELEASE_ID/backup-file.txt.tmp"
  mv -T -- ".releases/$PORTAL_BACKUP_RELEASE_ID/backup-file.txt.tmp" ".releases/$PORTAL_BACKUP_RELEASE_ID/backup-file.txt"
  printf '%s\n' "$PORTAL_BACKUP_NAME" > "$PORTAL_BACKUP_DIR/.latest-predeploy.tmp-$$"
  mv -T -- "$PORTAL_BACKUP_DIR/.latest-predeploy.tmp-$$" "$PORTAL_BACKUP_DIR/.latest-predeploy"
fi
if [[ -n "$PORTAL_OFFSITE_HOST" ]]; then
  if ! ssh -p "$PORTAL_OFFSITE_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_OFFSITE_HOST" "umask 077; mkdir -p -- '$PORTAL_OFFSITE_DIR'"; then
    printf 'Внешнее копирование не завершено. Локальная копия сохранена; очистка пропущена.\n' >&2
    exit 1
  fi
  # Publish the dump last so its presence marks a fully transferred bundle.
  PORTAL_OFFSITE_FILES=()
  [[ "$PORTAL_UPLOADS_CREATED" != true ]] || PORTAL_OFFSITE_FILES+=("$PORTAL_UPLOADS_NAME")
  PORTAL_OFFSITE_FILES+=("$PORTAL_BACKUP_NAME")
  for PORTAL_COPY_NAME in "${PORTAL_OFFSITE_FILES[@]}"; do
    PORTAL_CHECKSUM="$(sha256sum -- "$PORTAL_BACKUP_DIR/$PORTAL_COPY_NAME")"; PORTAL_CHECKSUM="${PORTAL_CHECKSUM%% *}"
    if ! scp -P "$PORTAL_OFFSITE_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_BACKUP_DIR/$PORTAL_COPY_NAME" "$PORTAL_OFFSITE_HOST:$PORTAL_OFFSITE_DIR/$PORTAL_COPY_NAME.partial" ||
       ! ssh -p "$PORTAL_OFFSITE_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_OFFSITE_HOST" "set -eu; cd '$PORTAL_OFFSITE_DIR'; chmod 600 '$PORTAL_COPY_NAME.partial'; printf '%s  %s\\n' '$PORTAL_CHECKSUM' '$PORTAL_COPY_NAME.partial' | sha256sum --check --status; mv -- '$PORTAL_COPY_NAME.partial' '$PORTAL_COPY_NAME'"; then
      printf 'Внешнее копирование не завершено. Локальные файлы сохранены; очистка пропущена.\n' >&2
      exit 1
    fi
  done
  printf 'Внешняя копия базы и доступных загрузок передана; SHA-256 совпадает.\n'
else
  printf 'Внешнее хранилище не настроено: эта копия находится только на VPS.\n'
fi
portal_prune_backups "$PORTAL_BACKUP_DIR" "$PORTAL_BACKUP_NAME" "$PORTAL_BACKUP_RETENTION_DAYS"
