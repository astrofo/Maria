#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
read -r -p 'E-mail первого администратора: ' ADMIN_EMAIL
read -r -s -p 'Пароль (не менее 12 символов): ' ADMIN_PASSWORD
printf '\n'
read -r -s -p 'Повторите пароль: ' PORTAL_PASSWORD_CONFIRMATION
printf '\n'
if [[ "$ADMIN_PASSWORD" != "$PORTAL_PASSWORD_CONFIRMATION" ]]; then
  printf 'Пароли не совпадают. Пользователь не создан.\n' >&2
  exit 1
fi
export ADMIN_EMAIL ADMIN_PASSWORD
trap 'unset ADMIN_PASSWORD ADMIN_EMAIL PORTAL_PASSWORD_CONFIRMATION' EXIT
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T -e ADMIN_EMAIL -e ADMIN_PASSWORD app node src/admin.js
