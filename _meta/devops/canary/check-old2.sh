#!/usr/bin/env bash
set -uo pipefail
echo "=== Old API Status ==="
systemctl is-active mindbliss-vp-api
echo "--- Local health ---"
for i in $(seq 1 6); do
  if curl -fsS http://127.0.0.1:3000/health 2>&1; then
    echo ""
    echo "LOCAL_HEALTH=OK attempt=$i"
    break
  fi
  echo "attempt $i failed"
  sleep 5
done
echo "--- No canary container ---"
docker ps -a --filter name=vp-api-canary --format '{{.Names}} {{.Status}}' 2>&1 || echo "none"
