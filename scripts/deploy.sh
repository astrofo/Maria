#!/usr/bin/env bash
# Run locally after SSH access and Docker Engine have been prepared on the VPS.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
PORTAL_DEPLOY_HOST="${PORTAL_DEPLOY_HOST:?Set PORTAL_DEPLOY_HOST=user@server}"
PORTAL_DEPLOY_ROOT="${PORTAL_DEPLOY_ROOT:-/opt/deti-marii}"
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
PORTAL_DEPLOY_DOMAIN="${PORTAL_DEPLOY_DOMAIN:-}"
PORTAL_SSH_PORT="${PORTAL_SSH_PORT:-22}"
if [[ ! "$PORTAL_DEPLOY_HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ || ! "$PORTAL_DEPLOY_ROOT" =~ ^/(opt|srv|home|root)/[a-zA-Z0-9_./-]+$ || "$PORTAL_DEPLOY_ROOT" == *..* ]]; then
  printf 'Проверьте SSH host и абсолютный путь установки (без пробелов и ..).\n' >&2
  exit 1
fi
if [[ ! "$PORTAL_SSH_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORTAL_SSH_PORT < 1 || 10#$PORTAL_SSH_PORT > 65535 )); then
  printf 'Неверный SSH порт.\n' >&2
  exit 1
fi
if [[ ! "$PORTAL_COMPOSE_FILE" =~ ^compose\.(production|server)\.yml$ || ! "$PORTAL_DEPLOY_DOMAIN" =~ ^[a-zA-Z0-9.-]*$ ]]; then
  printf 'Укажите серверный Compose и домен либо IPv4 без схемы/пути.\n' >&2
  exit 1
fi
PORTAL_SSH_OPTIONS=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
if [[ -n "${PORTAL_SSH_IDENTITY:-}" ]]; then
  PORTAL_SSH_OPTIONS+=(-i "$PORTAL_SSH_IDENTITY")
fi
if [[ -n "${PORTAL_SSH_CONTROL_PATH:-}" ]]; then
  if [[ "$PORTAL_SSH_CONTROL_PATH" == *$'\n'* || "$PORTAL_SSH_CONTROL_PATH" == *$'\r'* || "$PORTAL_SSH_CONTROL_PATH" == *'"'* || "$PORTAL_SSH_CONTROL_PATH" == *'\'* ]]; then
    printf 'ControlPath must not contain line breaks, quotes or backslashes.\n' >&2
    exit 1
  fi
  PORTAL_SSH_OPTIONS+=(-o "ControlPath=\"$PORTAL_SSH_CONTROL_PATH\"" -o ControlMaster=no)
fi
PORTAL_RELEASE_ID="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
PORTAL_LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/deti-marii-deploy.XXXXXXXX")"
PORTAL_REMOTE_STAGE=""
cleanup() {
  rm -rf -- "$PORTAL_LOCAL_STAGE"
  if [[ "$PORTAL_REMOTE_STAGE" =~ ^/tmp/deti-marii-release\.[a-zA-Z0-9]+$ ]]; then
    ssh -p "$PORTAL_SSH_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_DEPLOY_HOST" "rm -rf -- '$PORTAL_REMOTE_STAGE'" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
PORTAL_SOURCE_FILES=(Dockerfile .dockerignore .env.example package.json package-lock.json docker-compose.yml compose.production.yml compose.server.yml README.md src sql public scripts deploy)
[[ ! -d docs ]] || PORTAL_SOURCE_FILES+=(docs)
[[ ! -d integration ]] || PORTAL_SOURCE_FILES+=(integration)
COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --exclude='.DS_Store' --exclude='*/.DS_Store' -czf "$PORTAL_LOCAL_STAGE/source.tar.gz" "${PORTAL_SOURCE_FILES[@]}"
PORTAL_REMOTE_STAGE="$(ssh -p "$PORTAL_SSH_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_DEPLOY_HOST" 'umask 077; mktemp -d /tmp/deti-marii-release.XXXXXXXX')"
if [[ ! "$PORTAL_REMOTE_STAGE" =~ ^/tmp/deti-marii-release\.[a-zA-Z0-9]+$ ]]; then
  printf 'Не удалось создать временную папку на сервере.\n' >&2
  exit 1
fi
scp -P "$PORTAL_SSH_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_LOCAL_STAGE/source.tar.gz" scripts/apply-release.sh "$PORTAL_DEPLOY_HOST:$PORTAL_REMOTE_STAGE/"
ssh -p "$PORTAL_SSH_PORT" "${PORTAL_SSH_OPTIONS[@]}" "$PORTAL_DEPLOY_HOST" \
  "bash '$PORTAL_REMOTE_STAGE/apply-release.sh' '$PORTAL_REMOTE_STAGE/source.tar.gz' '$PORTAL_DEPLOY_ROOT' '$PORTAL_COMPOSE_FILE' '$PORTAL_DEPLOY_DOMAIN' '$PORTAL_RELEASE_ID'"
