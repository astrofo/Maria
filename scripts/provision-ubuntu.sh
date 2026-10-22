#!/usr/bin/env bash
# Run on the target Ubuntu host as root. Existing Docker installations are preserved.
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  printf 'Запустите от root или через sudo.\n' >&2
  exit 1
fi
source /etc/os-release
if [[ "$ID" != ubuntu || -z "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ]]; then
  printf 'Скрипт предназначен для Ubuntu.\n' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl rsync python3 util-linux
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker compose version
printf '\nDocker готов. Исходники, настройки и база существующего приложения не менялись.\n'
