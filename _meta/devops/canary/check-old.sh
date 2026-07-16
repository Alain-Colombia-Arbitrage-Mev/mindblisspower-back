#!/usr/bin/env bash
set -uo pipefail
echo "=== Old API Status ==="
systemctl is-active mindbliss-vp-api
systemctl status mindbliss-vp-api --no-pager -l | tail -20
echo "--- Local health ---"
for i in $(seq 1 6); do
  if curl -fsS http://127.0.0.1:3000/health 2>&1; then
    echo ""
    echo "LOCAL HEALTH OK on attempt $i"
    break
  fi
  echo "Attempt $i failed, waiting..."
  sleep 5
done
echo "--- Container status ---"
docker ps -a --filter name=vp-api-canary 2>&1 || true
