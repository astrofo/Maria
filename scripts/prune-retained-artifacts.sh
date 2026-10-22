#!/usr/bin/env bash
# Library: callers hold .backup.lock or .deploy.lock. GNU date/find, Linux VPS.
portal_backup_name() { [[ "$1" =~ ^portal-[0-9]{8}T[0-9]{6}Z-[0-9]+\.dump$ ]]; }
portal_release_id() { [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]; }
portal_managed_release() {
  [[ -d "$1" && ! -L "$1" && -f "$1/.managed-release" && ! -L "$1/.managed-release" ]] &&
    [[ "$(cat "$1/.managed-release")" == deti-marii-release-v1 ]]
}

portal_prune_backups() {
  # Only call after a new dump has been successfully created and inspected.
  local dir="$1" newest="$2" retention="$3"
  local stamp epoch day age week today current_week name pin release state companion count=0
  local -a files=()
  local -A keep=() daily=() weekly=()
  portal_backup_name "$newest" || return 1
  [[ -f "$dir/$newest" && ! -L "$dir/$newest" && -s "$dir/$newest" && ! -L "$dir" ]] || return 1
  today=$(( $(date -u +%s) / 86400 ))
  current_week=$(( (today + 3) / 7 ))
  keep["$newest"]=1
  if [[ -f "$dir/.latest-predeploy" && ! -L "$dir/.latest-predeploy" ]]; then
    pin="$(cat "$dir/.latest-predeploy")"
    if portal_backup_name "$pin"; then keep["$pin"]=1; fi
  fi
  # Interrupted/failed releases keep their recovery copy until resolved manually.
  if [[ -d .releases && ! -L .releases ]]; then
    while IFS= read -r -d '' release; do
      portal_release_id "${release##*/}" || continue
      portal_managed_release "$release" || continue
      [[ -f "$release/status" && ! -L "$release/status" ]] || continue
      state="$(cat "$release/status")"
      [[ "$state" == success ]] && continue
      [[ -f "$release/backup-file.txt" && ! -L "$release/backup-file.txt" ]] || continue
      pin="$(cat "$release/backup-file.txt")"
      if portal_backup_name "$pin"; then keep["$pin"]=1; fi
    done < <(find .releases -mindepth 1 -maxdepth 1 -type d -print0)
  fi
  while IFS= read -r name; do
    portal_backup_name "$name" || continue
    [[ -f "$dir/$name" && ! -L "$dir/$name" && -s "$dir/$name" ]] || continue
    files+=("$name")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name 'portal-*.dump' -printf '%f\n' | LC_ALL=C sort -r)
  for name in "${files[@]}"; do
    count=$((count + 1))
    if (( count <= 2 )); then keep["$name"]=1; fi
    stamp="${name:7:16}"
    if ! epoch="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z" +%s 2>/dev/null)"; then
      keep["$name"]=1; continue
    fi
    day=$(( epoch / 86400 )); age=$(( today - day )); week=$(( (day + 3) / 7 ))
    if (( age < 0 )); then keep["$name"]=1; continue; fi
    if (( age >= retention )); then continue; fi
    if (( age < 7 )) && [[ -z "${daily[$day]+set}" ]]; then
      keep["$name"]=1; daily["$day"]=1
    fi
    # Calendar weeks are stable; rolling age buckets would discard older tiers.
    if (( week >= current_week - 4 && week <= current_week )) && [[ -z "${weekly[$week]+set}" ]]; then
      keep["$name"]=1; weekly["$week"]=1
    fi
  done
  for name in "${files[@]}"; do
    [[ -z "${keep[$name]+set}" ]] || continue
    [[ -f "$dir/$name" && ! -L "$dir/$name" ]] || continue
    companion="$dir/${name%.dump}.uploads.tar.gz"
    # Only remove the exact managed companion. Unexpected paths/symlinks keep
    # the complete backup pair for an operator to inspect.
    if [[ -e "$companion" || -L "$companion" ]]; then
      [[ -f "$companion" && ! -L "$companion" ]] || continue
      rm -- "$companion" || return 1
    fi
    rm -- "$dir/$name" || return 1
    printf 'Удалена избыточная локальная копия: %s\n' "$name"
  done
}

portal_prune_releases() {
  local retain="${PORTAL_RELEASE_KEEP:-4}" current id dir state tag known_tags count=0
  [[ "$retain" =~ ^[3-5]$ ]] || { printf 'PORTAL_RELEASE_KEEP: допустимо 3–5.\n' >&2; return 1; }
  [[ -d .releases && ! -L .releases && -f .current-release && ! -L .current-release ]] || return 0
  current="$(cat .current-release)"
  portal_release_id "$current" || return 1
  portal_managed_release ".releases/$current" || return 1
  known_tags="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 'deti-marii-rollback:*')" || return 1
  while IFS= read -r id; do
    portal_release_id "$id" || continue
    dir=".releases/$id"
    portal_managed_release "$dir" || continue
    [[ -f "$dir/status" && ! -L "$dir/status" ]] || continue
    state="$(cat "$dir/status")"
    [[ "$state" == success ]] || continue
    count=$((count + 1))
    if (( count <= retain )) || [[ "$id" == "$current" ]]; then continue; fi
    tag="deti-marii-rollback:$id"
    if [[ -e "$dir/previous-app-image.txt" ]]; then
      [[ -f "$dir/previous-app-image.txt" && ! -L "$dir/previous-app-image.txt" ]] || continue
      [[ "$(cat "$dir/previous-app-image.txt")" == "$tag" ]] || continue
    fi
    if [[ $'\n'"$known_tags"$'\n' == *$'\n'"$tag"$'\n'* ]]; then
      # No force/global prune/volumes. In-use images are protected by Docker.
      if ! docker image rm --no-prune "$tag"; then
        printf 'Образ занят; материалы релиза %s сохранены.\n' "$id" >&2
        continue
      fi
    fi
    rm -rf --one-file-system -- "$dir" || return 1
    printf 'Удалён старый успешный релиз: %s\n' "$id"
  done < <(find .releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort -r)
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'Этот файл используется из backup.sh и apply-release.sh под блокировкой.\n' >&2
  exit 2
fi
