#!/usr/bin/env bash
# Run on the portal VPS after setting apex and www DNS records.
# Existing extra frontend origins are preserved as configured.
# This changes configuration only; it does not rebuild code or restore a database.
set -euo pipefail
umask 077

if (( $# < 1 || $# > 3 )); then
  printf 'Usage: bash connect-domain.sh domain [project-root] [Caddyfile.domain-template]\n' >&2
  exit 1
fi
PORTAL_DOMAIN="${1,,}"
PORTAL_ROOT="${2:-/opt/deti-marii}"
PORTAL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PORTAL_TEMPLATE="${3:-$PORTAL_SCRIPT_DIR/../deploy/Caddyfile.domain}"
if [[ ${#PORTAL_DOMAIN} -gt 253 || "$PORTAL_DOMAIN" == www.* || ! "$PORTAL_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
  printf 'Укажите основной домен без www, схемы и пути.\n' >&2
  exit 1
fi
if [[ ! "$PORTAL_ROOT" =~ ^/(opt|srv|home|root)/[a-zA-Z0-9_./-]+$ || "$PORTAL_ROOT" == *..* ]]; then
  printf 'Укажите канонический абсолютный каталог существующего портала.\n' >&2
  exit 1
fi
for PORTAL_COMMAND in docker python3 flock; do command -v "$PORTAL_COMMAND" > /dev/null; done
[[ -f "$PORTAL_TEMPLATE" && ! -L "$PORTAL_TEMPLATE" ]] || { printf 'Не найден обычный файл Caddyfile.domain.\n' >&2; exit 1; }
PORTAL_TEMPLATE="$(cd "$(dirname "$PORTAL_TEMPLATE")" && pwd -P)/$(basename "$PORTAL_TEMPLATE")"
cd "$PORTAL_ROOT"
[[ "$(pwd -P)" == "$PORTAL_ROOT" ]] || exit 1
[[ -f .env && ! -L .env && -f compose.production.yml && -f scripts/backup.sh && -d deploy && ! -L deploy ]] || {
  printf 'Не найдена ожидаемая production-установка портала.\n' >&2; exit 1;
}
[[ ! -L .deploy.lock && ! -L .backups && ! -L deploy/Caddyfile.domain ]] || exit 1
exec 9>.deploy.lock
flock -n 9 || { printf 'Другое обновление уже выполняется.\n' >&2; exit 1; }
# Compose must read these values from the existing .env, not an SSH shell.
unset DOMAIN PUBLIC_ORIGIN CADDY_CONFIG FRONTEND_ORIGINS
PORTAL_COMPOSE=(docker compose -f compose.production.yml)
[[ -n "$("${PORTAL_COMPOSE[@]}" ps -q app)" && -n "$("${PORTAL_COMPOSE[@]}" ps -q db)" ]] || {
  printf 'Существующие app и db должны быть запущены до смены адреса.\n' >&2; exit 1;
}

mkdir -p -m 700 .backups
PORTAL_SNAPSHOT="$PORTAL_ROOT/.backups/domain-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
mkdir -m 700 "$PORTAL_SNAPSHOT"
cp -p .env "$PORTAL_SNAPSHOT/env.before"
chmod 600 "$PORTAL_SNAPSHOT/env.before"
cp -p compose.production.yml "$PORTAL_SNAPSHOT/compose.production.yml"
cp -a deploy "$PORTAL_SNAPSHOT/deploy.before"
cp "$PORTAL_TEMPLATE" "$PORTAL_SNAPSHOT/Caddyfile.domain.new"
printf '%s\n' "$PORTAL_DOMAIN" > "$PORTAL_SNAPSHOT/domain.txt"
printf '%s\n' prepared > "$PORTAL_SNAPSHOT/status"
PORTAL_ENV_PENDING="$PORTAL_ROOT/.env.domain-pending-$$"
PORTAL_CADDY_PENDING="$PORTAL_ROOT/deploy/.Caddyfile.domain-pending-$$"
[[ ! -e "$PORTAL_ENV_PENDING" && ! -L "$PORTAL_ENV_PENDING" && ! -e "$PORTAL_CADDY_PENDING" && ! -L "$PORTAL_CADDY_PENDING" ]] || exit 1
PORTAL_CONFIGURATION_CHANGED=false
PORTAL_COMPLETE=false

portal_domain_exit() {
  local result=$? restore_file caddy_restored=true
  set +e
  if [[ "$PORTAL_CONFIGURATION_CHANGED" == true && "$PORTAL_COMPLETE" != true ]]; then
    printf 'Применение не завершено; возвращаем предыдущую конфигурацию.\n' >&2
    restore_file="$(mktemp "$PORTAL_ROOT/.env.domain-restore.XXXXXXXX")"
    if [[ -n "$restore_file" ]] && cp "$PORTAL_SNAPSHOT/env.before" "$restore_file" && chmod 600 "$restore_file" && mv -f -- "$restore_file" "$PORTAL_ROOT/.env"; then
      if [[ -f "$PORTAL_SNAPSHOT/deploy.before/Caddyfile.domain" ]]; then
        cp "$PORTAL_SNAPSHOT/deploy.before/Caddyfile.domain" "$PORTAL_ROOT/deploy/Caddyfile.domain" || caddy_restored=false
      else
        rm -f -- "$PORTAL_ROOT/deploy/Caddyfile.domain" || caddy_restored=false
      fi
      if [[ "$caddy_restored" == true ]] && "${PORTAL_COMPOSE[@]}" up -d --no-build --no-deps --force-recreate --wait --wait-timeout 180 app caddy >> "$PORTAL_SNAPSHOT/rollback.log" 2>&1; then
        printf '%s\n' rolled-back > "$PORTAL_SNAPSHOT/status"
        printf 'Предыдущая конфигурация восстановлена.\n' >&2
      else
        printf '%s\n' rollback-needs-attention > "$PORTAL_SNAPSHOT/status"
        printf 'Автоматическое восстановление конфигурации/контейнеров требует проверки.\n' >&2
      fi
    else
      printf '%s\n' rollback-needs-attention > "$PORTAL_SNAPSHOT/status"
      printf 'Автоматическое восстановление .env не удалось; используйте приватную копию.\n' >&2
    fi
    printf 'Материалы восстановления: %s\n' "$PORTAL_SNAPSHOT" >&2
  fi
  rm -f -- "$PORTAL_ENV_PENDING" "$PORTAL_CADDY_PENDING"
  return "$result"
}
trap portal_domain_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Preserve every other value verbatim, including quoted multiline secrets.
# The parser only identifies dotenv assignment boundaries; it never executes them.
python3 - "$PORTAL_DOMAIN" "$PORTAL_ENV_PENDING" <<'PY'
from pathlib import Path
import os, re, sys

domain, destination = sys.argv[1:]
text = Path('.env').read_bytes().decode('utf-8')
lines = text.splitlines(keepends=True)
updates = {'DOMAIN': domain, 'PUBLIC_ORIGIN': 'https://' + domain,
           'CADDY_CONFIG': './deploy/Caddyfile.domain'}
assignment = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
newline = '\r\n' if '\r\n' in text else '\n'

seen, output, position = set(), [], 0
while position < len(lines):
    record = lines[position]
    position += 1
    match = assignment.match(record.rstrip('\r\n'))
    if match:
        key, value = match.groups()
        if value.startswith(('"', "'", '`')):
            quote, remaining, escaped = value[0], value[1:], False
            while True:
                closed = False
                for char in remaining:
                    if escaped:
                        escaped = False
                    elif char == '\\':
                        escaped = True
                    elif char == quote:
                        closed = True
                        break
                if closed:
                    break
                if position >= len(lines):
                    raise SystemExit('Незавершённое quoted-значение в .env; изменения не применены.')
                remaining = lines[position]
                record += remaining
                position += 1
                escaped = False
        if key in updates:
            if key in seen:
                raise SystemExit('Повтор адресного параметра в .env; изменения не применены.')
            seen.add(key)
            record = key + '=' + updates[key] + newline
    output.append(record)
result = ''.join(output)
if result and not result.endswith(('\n', '\r')):
    result += newline
for key, value in updates.items():
    if key not in seen:
        result += key + '=' + value + newline
with open(destination, 'x', encoding='utf-8', newline='') as file:
    os.chmod(destination, 0o600)
    file.write(result)
    file.flush()
    os.fsync(file.fileno())
PY

# A failed database backup aborts the change before .env or Caddy is touched.
PORTAL_PROJECT_ROOT="$PORTAL_ROOT" PORTAL_COMPOSE_FILE=compose.production.yml PORTAL_BACKUP_DIR=.backups bash scripts/backup.sh > "$PORTAL_SNAPSHOT/backup.log" 2>&1 || {
  printf 'Резервная копия не завершена. Настройки не изменены; журнал: %s/backup.log\n' "$PORTAL_SNAPSHOT" >&2
  exit 1
}
cp "$PORTAL_SNAPSHOT/Caddyfile.domain.new" "$PORTAL_CADDY_PENDING"
chmod 644 "$PORTAL_CADDY_PENDING"
PORTAL_CONFIGURATION_CHANGED=true
mv -f -- "$PORTAL_CADDY_PENDING" deploy/Caddyfile.domain
mv -f -- "$PORTAL_ENV_PENDING" .env
"${PORTAL_COMPOSE[@]}" config --quiet > "$PORTAL_SNAPSHOT/apply.log" 2>&1
"${PORTAL_COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >> "$PORTAL_SNAPSHOT/apply.log" 2>&1
"${PORTAL_COMPOSE[@]}" up -d --no-build --no-deps --force-recreate --wait --wait-timeout 180 app caddy >> "$PORTAL_SNAPSHOT/apply.log" 2>&1
PORTAL_COMPLETE=true
printf '%s\n' configuration-applied > "$PORTAL_SNAPSHOT/status"
printf 'Конфигурация применена для https://%s и перенаправления www на основной адрес.\n' "$PORTAL_DOMAIN"
printf 'Сертификаты домена ожидают доступного DNS; подтвердите HTTPS и перенаправление отдельно.\n'
printf 'Приватная копия прежних настроек: %s\n' "$PORTAL_SNAPSHOT"
printf 'Секреты и данные сохранены; на новом домене потребуется войти заново.\n'
