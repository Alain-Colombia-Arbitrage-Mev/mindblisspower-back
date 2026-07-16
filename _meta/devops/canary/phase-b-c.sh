#!/usr/bin/env bash
set -uo pipefail
export PATH="$PATH:/usr/local/bin:/usr/bin"

IMAGE="522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:437bf36180f725c9ce85c0b605d3eb8ed90f1dd3"
ROLLBACK_NEEDED=0

echo "=== Phase B: Cutover ==="

# 5. Stop old api
echo "--- Stopping mindbliss-vp-api ---"
systemctl stop mindbliss-vp-api
echo "Old api stopped"

# 6. Start container with host networking
echo "--- Starting vp-api-canary container ---"
docker rm -f vp-api-canary 2>/dev/null || true
docker run -d \
  --name vp-api-canary \
  --network host \
  --restart unless-stopped \
  --env-file /run/vicionpower/api.env \
  "$IMAGE"
echo "Container started"

echo "=== Phase C: Health Gate ==="

# 7. Local health check — up to 12 attempts x 5s = 60s
echo "--- Local health check ---"
LOCAL_OK=0
for i in $(seq 1 12); do
  echo "Attempt $i/12..."
  if curl -fsS http://127.0.0.1:3000/health 2>&1; then
    echo ""
    echo "LOCAL HEALTH PASS on attempt $i"
    LOCAL_OK=1
    break
  fi
  sleep 5
done

if [ "$LOCAL_OK" -ne 1 ]; then
  echo "LOCAL HEALTH FAILED after 60s — capturing logs and rolling back"
  echo "=== CONTAINER LOGS ==="
  docker logs --tail 50 vp-api-canary 2>&1 || true
  echo "=== ROLLBACK ==="
  docker rm -f vp-api-canary 2>/dev/null || true
  systemctl start mindbliss-vp-api
  echo "Old api restarted, waiting for it..."
  for i in $(seq 1 6); do
    if curl -fsS http://127.0.0.1:3000/health 2>&1; then
      echo ""
      echo "OLD API RESTORED on attempt $i"
      break
    fi
    sleep 5
  done
  echo "ROLLBACK_STATUS=LOCAL_HEALTH_FAILED"
  exit 1
fi

echo "=== Phase C: Container logs (last 30) ==="
docker logs --tail 30 vp-api-canary 2>&1 || true

echo "CANARY_LOCAL_HEALTH=PASS"
