#!/usr/bin/env bash
# Called on the VPS by deploy.sh. Does not install Docker or modify SSH/firewalls.
set -euo pipefail
umask 077
if [[ $# != 5 ]]; then
  printf 'Arguments: archive install-directory compose-file domain-or-ip release-id\n' >&2
  exit 1
fi
PORTAL_ARCHIVE="$1"
PORTAL_ROOT="$2"
PORTAL_COMPOSE_FILE="$3"
PORTAL_DOMAIN="$4"
PORTAL_RELEASE_ID="$5"
if [[ ! "$PORTAL_ROOT" =~ ^/(opt|srv|home|root)/[a-zA-Z0-9_./-]+$ || "$PORTAL_ROOT" == *..* || ! "$PORTAL_COMPOSE_FILE" =~ ^compose\.(production|server)\.yml$ || ! "$PORTAL_RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ || ! "$PORTAL_DOMAIN" =~ ^[a-zA-Z0-9.-]*$ ]]; then
  printf 'Invalid deployment arguments.\n' >&2
  exit 1
fi
for PORTAL_COMMAND in docker rsync flock tar python3; do command -v "$PORTAL_COMMAND" > /dev/null; done
docker compose version > /dev/null
test -f "$PORTAL_ARCHIVE"
mkdir -p "$PORTAL_ROOT"
cd "$PORTAL_ROOT"
if [[ "$(pwd -P)" != "$PORTAL_ROOT" ]]; then
  printf 'Use the canonical installation path without symlinks or trailing slash.\n' >&2
  exit 1
fi
if [[ -d src || -d public || -d sql ]] && [[ ! -f compose.production.yml || ! -f package.json ]]; then
  printf 'Existing source directories do not look like this portal. Choose an empty installation directory.\n' >&2
  exit 1
fi
[[ ! -L .deploy.lock && ! -L .releases && ! -L .current-release ]] || { printf 'Deployment metadata must not be symbolic links.\n' >&2; exit 1; }
for PORTAL_ITEM in .env .deployment-compose .backups src sql public scripts deploy docs integration; do
  [[ ! -L "$PORTAL_ITEM" ]] || { printf 'Managed paths must not be symbolic links.\n' >&2; exit 1; }
done
exec 9>.deploy.lock
flock -n 9 || { printf 'Another deployment is running.\n' >&2; exit 1; }
if [[ -f .deployment-compose ]] && [[ "$(cat .deployment-compose)" == compose.production.yml && "$PORTAL_COMPOSE_FILE" == compose.server.yml ]]; then
  printf 'Refusing to change a public deployment to the private preparation mode automatically.\n' >&2
  exit 1
fi
if [[ ! -f .env && "$PORTAL_COMPOSE_FILE" == compose.production.yml && -z "$PORTAL_DOMAIN" ]]; then
  printf 'Initial public installation requires PORTAL_DEPLOY_DOMAIN (domain or public IPv4).\n' >&2
  exit 1
fi
PORTAL_RELEASE_DIR="$PORTAL_ROOT/.releases/$PORTAL_RELEASE_ID"
[[ ! -e "$PORTAL_RELEASE_DIR" && ! -L "$PORTAL_RELEASE_DIR" ]] || { printf 'This release ID already exists.\n' >&2; exit 1; }
mkdir -p -m 700 "$PORTAL_ROOT/.releases"
mkdir -m 700 "$PORTAL_RELEASE_DIR"
printf '%s\n' deti-marii-release-v1 > "$PORTAL_RELEASE_DIR/.managed-release"
printf '%s\n' pending > "$PORTAL_RELEASE_DIR/status"
PORTAL_RELEASE_SUCCEEDED=false
portal_release_exit() {
  local result=$?
  if [[ "$PORTAL_RELEASE_SUCCEEDED" != true ]]; then
    printf '%s\n' failed > "$PORTAL_RELEASE_DIR/status.tmp"
    mv -T -- "$PORTAL_RELEASE_DIR/status.tmp" "$PORTAL_RELEASE_DIR/status"
    printf 'Release %s did not finish. Recovery material is preserved.\n' "$PORTAL_RELEASE_ID" >&2
  fi
  return "$result"
}
trap portal_release_exit EXIT
mkdir -m 700 "$PORTAL_RELEASE_DIR/source"
# Reject links and special files before extraction: checking after extraction
# cannot protect against an archive writing through an earlier symlink.
python3 - "$PORTAL_ARCHIVE" <<'PY'
import pathlib, sys, tarfile

allowed = {'Dockerfile', '.dockerignore', '.env.example', 'package.json',
           'package-lock.json', 'docker-compose.yml', 'compose.production.yml',
           'compose.server.yml', 'README.md', 'src', 'sql', 'public', 'scripts',
           'deploy', 'docs', 'integration'}
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if (not member.name or not path.parts or path.is_absolute() or '..' in path.parts or
                path.parts[0] not in allowed or '\\' in member.name or
                any(ord(char) < 32 for char in member.name) or
                not (member.isfile() or member.isdir())):
            raise SystemExit('Unsafe source archive member; nothing extracted.')
PY
tar -tzf "$PORTAL_ARCHIVE" > "$PORTAL_RELEASE_DIR/archive-files.txt"
while IFS= read -r PORTAL_MEMBER; do
  case "$PORTAL_MEMBER" in /*|../*|*/../*|*/..) printf 'Unsafe archive member.\n' >&2; exit 1;; esac
  case "${PORTAL_MEMBER%%/*}" in Dockerfile|.dockerignore|.env.example|package.json|package-lock.json|docker-compose.yml|compose.production.yml|compose.server.yml|README.md|src|sql|public|scripts|deploy|docs|integration) ;;
    *) printf 'Unexpected archive member: %s\n' "$PORTAL_MEMBER" >&2; exit 1;;
  esac
done < "$PORTAL_RELEASE_DIR/archive-files.txt"
tar --no-same-owner --no-same-permissions -xzf "$PORTAL_ARCHIVE" -C "$PORTAL_RELEASE_DIR/source"
if [[ -n "$(find "$PORTAL_RELEASE_DIR/source" -type l -print -quit)" ]]; then
  printf 'Source archives with symlinks are not accepted.\n' >&2
  exit 1
fi
test -f "$PORTAL_RELEASE_DIR/source/package-lock.json"
test -f "$PORTAL_RELEASE_DIR/source/$PORTAL_COMPOSE_FILE"
test -f "$PORTAL_RELEASE_DIR/source/scripts/backup.sh"
source "$PORTAL_RELEASE_DIR/source/scripts/prune-retained-artifacts.sh"
PORTAL_OLD_FILES=()
for PORTAL_ITEM in Dockerfile .dockerignore .env.example package.json package-lock.json docker-compose.yml compose.production.yml compose.server.yml README.md src sql public scripts deploy docs integration; do
  [[ ! -e "$PORTAL_ITEM" ]] || PORTAL_OLD_FILES+=("$PORTAL_ITEM")
done
if (( ${#PORTAL_OLD_FILES[@]} )); then
  tar -czf "$PORTAL_RELEASE_DIR/previous-source.tar.gz" "${PORTAL_OLD_FILES[@]}"
fi
PORTAL_BACKUP_DONE=false
if [[ -f .env && -f "$PORTAL_COMPOSE_FILE" ]]; then
  docker compose -f "$PORTAL_COMPOSE_FILE" up -d --wait --wait-timeout 120 db
  # Use the incoming policy even on the first upgrade from an older script.
  PORTAL_PROJECT_ROOT="$PORTAL_ROOT" PORTAL_BACKUP_RELEASE_ID="$PORTAL_RELEASE_ID" PORTAL_COMPOSE_FILE="$PORTAL_COMPOSE_FILE" bash "$PORTAL_RELEASE_DIR/source/scripts/backup.sh"
  PORTAL_BACKUP_DONE=true
  PORTAL_PREVIOUS_IMAGE="$(docker compose -f "$PORTAL_COMPOSE_FILE" images -q app | head -n 1)"
  if [[ -n "$PORTAL_PREVIOUS_IMAGE" ]]; then
    docker image tag "$PORTAL_PREVIOUS_IMAGE" "deti-marii-rollback:$PORTAL_RELEASE_ID"
    printf 'deti-marii-rollback:%s\n' "$PORTAL_RELEASE_ID" > "$PORTAL_RELEASE_DIR/previous-app-image.txt"
  fi
fi
# Delete obsolete code only within the explicitly managed source directories.
# Environment, backups, release snapshots, Docker volumes and unrelated files persist.
for PORTAL_DIRECTORY in src sql public scripts deploy docs integration; do
  if [[ -d "$PORTAL_RELEASE_DIR/source/$PORTAL_DIRECTORY" ]]; then
    mkdir -p "$PORTAL_DIRECTORY"
    rsync -a --delete "$PORTAL_RELEASE_DIR/source/$PORTAL_DIRECTORY/" "$PORTAL_DIRECTORY/"
  fi
done
for PORTAL_ITEM in Dockerfile .dockerignore .env.example package.json package-lock.json docker-compose.yml compose.production.yml compose.server.yml README.md; do
  [[ ! -f "$PORTAL_RELEASE_DIR/source/$PORTAL_ITEM" ]] || cp "$PORTAL_RELEASE_DIR/source/$PORTAL_ITEM" "$PORTAL_ITEM"
done
if [[ ! -f .env ]]; then
  PORTAL_CONFIG_ARGS=(--mode server)
  [[ "$PORTAL_COMPOSE_FILE" != compose.production.yml ]] || PORTAL_CONFIG_ARGS=(--mode production --domain "$PORTAL_DOMAIN")
  docker run --rm --user "$(id -u):$(id -g)" -v "$PORTAL_ROOT:/work" -w /work node:24-bookworm-slim node scripts/configure.mjs "${PORTAL_CONFIG_ARGS[@]}"
fi
docker compose -f "$PORTAL_COMPOSE_FILE" build app
docker compose -f "$PORTAL_COMPOSE_FILE" up -d --wait --wait-timeout 180
printf '%s\n' "$PORTAL_COMPOSE_FILE" > .deployment-compose
if [[ "$PORTAL_BACKUP_DONE" == false ]]; then
  PORTAL_BACKUP_RELEASE_ID="$PORTAL_RELEASE_ID" PORTAL_COMPOSE_FILE="$PORTAL_COMPOSE_FILE" bash scripts/backup.sh
fi
if [[ "$EUID" == 0 ]]; then
  PORTAL_COMPOSE_FILE="$PORTAL_COMPOSE_FILE" bash scripts/install-backup-timer.sh
else
  printf 'Install the daily backup timer once as root: sudo env PORTAL_COMPOSE_FILE=%s bash scripts/install-backup-timer.sh\n' "$PORTAL_COMPOSE_FILE"
fi
docker compose -f "$PORTAL_COMPOSE_FILE" ps
printf '%s\n' "$PORTAL_RELEASE_ID" > .current-release.tmp
mv -T -- .current-release.tmp .current-release
printf '%s\n' success > "$PORTAL_RELEASE_DIR/status.tmp"
mv -T -- "$PORTAL_RELEASE_DIR/status.tmp" "$PORTAL_RELEASE_DIR/status"
PORTAL_RELEASE_SUCCEEDED=true
if ! portal_prune_releases; then
  printf 'Release is healthy; retention cleanup needs operator attention. No database rollback was attempted.\n' >&2
fi
printf 'Release %s started. Source rollback material: %s\n' "$PORTAL_RELEASE_ID" "$PORTAL_RELEASE_DIR"
printf 'Database migrations are not rolled back automatically. Check HTTPS separately.\n'
