#!/usr/bin/env bash
set -euo pipefail
echo "=== Rollback verification ==="
echo "--- systemd units ---"
systemctl is-active mindbliss-vp-api || true
systemctl is-active mindbliss-vp-engine || true
echo "--- docker ps ---"
docker ps
echo "--- api local health ---"
curl -fsS http://127.0.0.1:3000/health || echo "local health FAILED"
echo ""
echo "--- https health ---"
curl -fsS https://api.mindblisspower.com/health || echo "https health FAILED"
echo ""
echo "--- where is systemd engine running? ---"
ss -tlnp | grep 50051 || echo "50051 not listening"
echo "--- compose ps (should be empty) ---"
docker compose -f /opt/vicion/compose/server2.yml ps 2>/dev/null || echo "no compose stack running"
echo "=== Done ==="
