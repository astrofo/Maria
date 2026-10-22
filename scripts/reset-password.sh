#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
read -r -p 'E-mail пользователя, чей пароль нужно заменить: ' RESET_EMAIL
read -r -s -p 'Новый пароль (не менее 12 символов): ' RESET_PASSWORD
printf '\n'
read -r -s -p 'Повторите новый пароль: ' PORTAL_PASSWORD_CONFIRMATION
printf '\n'
if [[ "$RESET_PASSWORD" != "$PORTAL_PASSWORD_CONFIRMATION" ]]; then
  printf 'Пароли не совпадают. Ничего не изменено.\n' >&2
  exit 1
fi
export RESET_EMAIL RESET_PASSWORD
trap 'unset RESET_PASSWORD RESET_EMAIL PORTAL_PASSWORD_CONFIRMATION' EXIT
docker compose -f "$PORTAL_COMPOSE_FILE" exec -T -e RESET_EMAIL -e RESET_PASSWORD app node src/reset-password.js
