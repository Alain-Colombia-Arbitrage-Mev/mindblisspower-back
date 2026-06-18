#!/usr/bin/env bash
# Install Docker Engine + compose plugin on Ubuntu (arm64 or amd64).
# Handles Ubuntu 26.04 (plucky/oracular) where docker.com repo may not yet publish packages
# by falling back first to 'noble' (24.04 LTS) codename, then to ubuntu's docker.io packages.
set -euo pipefail

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "docker+compose ya instalados: $(docker --version)"
  docker compose version
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
ARCH=$(dpkg --print-architecture)

# Try native codename first
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

if apt-get update -y 2>&1 | grep -q "404\|No such file"; then
  echo "[WARN] Docker repo has no packages for ${VERSION_CODENAME}, falling back to noble (24.04)"
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    > /etc/apt/sources.list.d/docker.list
  if apt-get update -y 2>&1 | grep -q "404\|No such file"; then
    echo "[WARN] noble fallback also failed; installing ubuntu docker.io packages"
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2
    usermod -aG docker ubuntu || true
    systemctl enable --now docker
    docker --version && docker compose version
    exit 0
  fi
fi

apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu || true
systemctl enable --now docker
docker --version && docker compose version
