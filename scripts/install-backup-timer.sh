#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORTAL_ROOT="$(pwd -P)"
PORTAL_COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-compose.production.yml}"
if [[ "$EUID" != 0 ]]; then
  printf 'Запустите от root: sudo env PORTAL_COMPOSE_FILE=%s bash scripts/install-backup-timer.sh\n' "$PORTAL_COMPOSE_FILE" >&2
  exit 1
fi
if [[ ! "$PORTAL_ROOT" =~ ^/[a-zA-Z0-9_./-]+$ || "$PORTAL_ROOT" == / || ! "$PORTAL_COMPOSE_FILE" =~ ^compose\.(production|server)\.yml$ ]]; then
  printf 'Для systemd используйте серверную папку без пробелов и compose.production.yml или compose.server.yml.\n' >&2
  exit 1
fi
test -f .env
test -f "$PORTAL_COMPOSE_FILE"
test -f scripts/backup.sh
test -f scripts/prune-retained-artifacts.sh
command -v systemctl > /dev/null
command -v flock > /dev/null
sed -e "s|@PORTAL_ROOT@|$PORTAL_ROOT|g" -e "s|@PORTAL_COMPOSE_FILE@|$PORTAL_COMPOSE_FILE|g" deploy/systemd/deti-marii-backup.service > /etc/systemd/system/deti-marii-backup.service
install -m 644 deploy/systemd/deti-marii-backup.timer /etc/systemd/system/deti-marii-backup.timer
chmod 644 /etc/systemd/system/deti-marii-backup.service
systemctl daemon-reload
systemctl enable --now deti-marii-backup.timer
systemctl list-timers --all deti-marii-backup.timer --no-pager
