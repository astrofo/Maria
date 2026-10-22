#!/usr/bin/env bash
# Run on the VPS: prepares only the pinned image/model; does not edit .env or app.
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORTAL_SOURCE_ROOT="$(pwd -P)"
PORTAL_PROJECT_ROOT="${PORTAL_PROJECT_ROOT:-/opt/deti-marii}"
PORTAL_MODE="${1:---download}"
[[ $# -le 1 && ( "$PORTAL_MODE" == --download || "$PORTAL_MODE" == --verify ) ]] || {
  printf 'Usage on VPS: bash scripts/prepare-assistant.sh [--download|--verify]\n' >&2; exit 1;
}
[[ "$PORTAL_PROJECT_ROOT" =~ ^/(opt|srv|home|root)/[a-zA-Z0-9_./-]+$ && "$PORTAL_PROJECT_ROOT" != *..* ]] || exit 1
[[ "$EUID" == 0 && "$(uname -s)" == Linux ]] || { printf 'Run as root on the Linux VPS.\n' >&2; exit 1; }
for PORTAL_COMMAND in docker flock timeout sha256sum; do command -v "$PORTAL_COMMAND" > /dev/null; done
[[ -d "$PORTAL_PROJECT_ROOT" && ! -L "$PORTAL_PROJECT_ROOT/.assistant-model.lock" ]] || exit 1
exec 9>"$PORTAL_PROJECT_ROOT/.assistant-model.lock"
flock -n 9 || { printf 'Another model preparation is running.\n' >&2; exit 1; }
PORTAL_IMAGE='ollama/ollama:0.40.8@sha256:2b8eecdb85aa6ea67c381c8ecffec04b2658496cf2821a8f88b0485bdff198e8'
PORTAL_VOLUME=deti-marii-assistant-models
PORTAL_STAMP="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
PORTAL_LOADER="deti-marii-assistant-loader-$PORTAL_STAMP"
PORTAL_OWNS_LOADER=false
PORTAL_LOG_ROOT="$PORTAL_PROJECT_ROOT/.assistant-preparation"
[[ ! -L "$PORTAL_LOG_ROOT" ]] || exit 1
mkdir -p -m 700 "$PORTAL_LOG_ROOT"
PORTAL_LOG_DIR="$PORTAL_LOG_ROOT/$PORTAL_STAMP"
mkdir -m 700 "$PORTAL_LOG_DIR"
portal_assistant_cleanup() {
  local result=$?
  if [[ "$PORTAL_OWNS_LOADER" == true ]]; then
    docker stop -t 10 "$PORTAL_LOADER" > /dev/null 2>&1 || true
    docker rm "$PORTAL_LOADER" > /dev/null 2>&1 || true
  fi
  return "$result"
}
trap portal_assistant_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
[[ -f deploy/assistant-model.sha256 && -f deploy/assistant-model-manifest.json ]] || exit 1
printf '%s  %s\n' '7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435' deploy/assistant-model-manifest.json | sha256sum -c --status
if ! docker image inspect "$PORTAL_IMAGE" > /dev/null 2>&1; then
  [[ "$PORTAL_MODE" == --download ]] || { printf 'Pinned runtime image is not installed.\n' >&2; exit 1; }
  docker pull "$PORTAL_IMAGE"
fi
if ! docker volume inspect "$PORTAL_VOLUME" > /dev/null 2>&1; then
  [[ "$PORTAL_MODE" == --download ]] || { printf 'Model volume is not prepared.\n' >&2; exit 1; }
  docker volume create --label org.deti-marii.purpose=assistant-models "$PORTAL_VOLUME" > /dev/null
fi
[[ "$(docker volume inspect --format '{{index .Labels "org.deti-marii.purpose"}}' "$PORTAL_VOLUME")" == assistant-models ]] || {
  printf 'Refusing an unrecognised model volume.\n' >&2; exit 1;
}
portal_verify_model() {
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 1536m --memory-swap 1536m --cpus 1 --pids-limit 128 \
    --mount "type=volume,src=$PORTAL_VOLUME,dst=/root/.ollama,readonly" \
    --mount "type=bind,src=$PORTAL_SOURCE_ROOT/deploy/assistant-model.sha256,dst=/bootstrap/model.sha256,readonly" \
    --entrypoint /bin/sh "$PORTAL_IMAGE" -c 'cd /root/.ollama && sha256sum -c /bootstrap/model.sha256' \
    > "$PORTAL_LOG_DIR/integrity.log" 2>&1
}
if portal_verify_model; then
  printf 'Pinned image, manifest and all model blobs are already present and verified.\n'
  printf '%s\n' verified-existing > "$PORTAL_LOG_DIR/status"
  exit 0
fi
[[ "$PORTAL_MODE" == --download ]] || { printf 'Model integrity check failed; private log: %s/integrity.log\n' "$PORTAL_LOG_DIR" >&2; exit 1; }
if [[ -n "$(docker ps -q --filter "volume=$PORTAL_VOLUME")" ]]; then
  printf 'Stop the model runtime before changing its volume; the portal app can stay running.\n' >&2
  exit 1
fi
# A temporary container gets egress only for the official model download. It has
# no app/database mounts, no credentials, no published ports, and no chat input.
docker run -d --name "$PORTAL_LOADER" --network bridge --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 1536m --memory-swap 1536m \
  --cpus 1 --pids-limit 128 --tmpfs /tmp:size=128m,mode=1777 \
  --mount "type=volume,src=$PORTAL_VOLUME,dst=/root/.ollama" \
  -e OLLAMA_HOST=127.0.0.1:11434 -e OLLAMA_NO_CLOUD=1 -e OLLAMA_NOHISTORY=1 \
  -e OLLAMA_NOPRUNE=1 -e OLLAMA_DEBUG=false -e OLLAMA_DEBUG_LOG_REQUESTS=false \
  -e OLLAMA_VULKAN=0 -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -e OLLAMA_MAX_QUEUE=2 -e OLLAMA_CONTEXT_LENGTH=2048 "$PORTAL_IMAGE" \
  > "$PORTAL_LOG_DIR/loader-id"
PORTAL_OWNS_LOADER=true
PORTAL_READY=false
for PORTAL_ATTEMPT in {1..30}; do
  if docker exec "$PORTAL_LOADER" ollama list > /dev/null 2>&1; then PORTAL_READY=true; break; fi
  sleep 2
done
if [[ "$PORTAL_READY" != true ]]; then
  docker logs "$PORTAL_LOADER" > "$PORTAL_LOG_DIR/loader.log" 2>&1 || true
  printf 'Temporary download service did not become ready. Log: %s/loader.log\n' "$PORTAL_LOG_DIR" >&2
  exit 1
fi
printf 'Downloading qwen3:0.6b; output stays in %s/pull.log\n' "$PORTAL_LOG_DIR"
if ! timeout 900 docker exec "$PORTAL_LOADER" ollama pull qwen3:0.6b > "$PORTAL_LOG_DIR/pull.log" 2>&1; then
  printf 'Model download did not complete; existing data was not deleted. Log: %s/pull.log\n' "$PORTAL_LOG_DIR" >&2
  exit 1
fi
docker stop -t 10 "$PORTAL_LOADER" > /dev/null
docker rm "$PORTAL_LOADER" > /dev/null
PORTAL_OWNS_LOADER=false
if ! portal_verify_model; then
  printf 'Downloaded model differs from the pinned manifest/blobs; do not enable it. Log: %s/integrity.log\n' "$PORTAL_LOG_DIR" >&2
  exit 1
fi
printf '%s\n' verified-downloaded > "$PORTAL_LOG_DIR/status"
printf 'Pinned image and Qwen3 0.6B Q4_K_M are ready in %s.\n' "$PORTAL_VOLUME"
printf 'No generation request, .env change, app restart or permanent network service was performed.\n'
