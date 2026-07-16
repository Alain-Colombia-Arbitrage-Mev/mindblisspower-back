#!/usr/bin/env bash
# Phase C+D: health gate + decision (with automatic rollback)
set -euo pipefail

IMAGE_TAG="a31cc2c6f3cd70133f32aa40d2f51eb982695727"
REGISTRY="522814703714.dkr.ecr.us-east-1.amazonaws.com"
COMPOSE_FILE="/opt/vicion/compose/server2.yml"
ENV_DIR="/run/vicionpower"
REGION="us-east-1"

export IMAGE_TAG REGISTRY

FAIL=0
FAIL_REASON=""

rollback() {
  echo "=== ROLLING BACK ==="
  echo "--- Capturing compose logs before teardown ---"
  docker compose -f "$COMPOSE_FILE" logs --tail=60 api || true
  docker compose -f "$COMPOSE_FILE" logs --tail=60 vp-engine || true

  docker compose -f "$COMPOSE_FILE" down || true

  echo "--- Restarting mindbliss-vp-engine systemd ---"
  systemctl start mindbliss-vp-engine || echo "WARNING: could not start mindbliss-vp-engine"
  sleep 3
  systemctl is-active mindbliss-vp-engine || true

  echo "--- Re-launching vp-api-canary ---"
  docker run -d \
    --name vp-api-canary \
    --network host \
    --restart unless-stopped \
    --env-file "$ENV_DIR/api.env" \
    "$REGISTRY/vp/api:$IMAGE_TAG"

  echo "--- Verifying canary health ---"
  for i in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3000/health > /dev/null 2>&1; then
      echo "Canary api local: HEALTHY (attempt $i)"
      break
    fi
    echo "Attempt $i: not ready, sleeping 5s..."
    sleep 5
  done

  echo "--- https://api.mindblisspower.com/health ---"
  curl -fsS https://api.mindblisspower.com/health || echo "https check failed"

  echo "ROLLED_BACK: $FAIL_REASON"
  exit 1
}

echo "=== Phase C: Health Gate ==="

# Step 8: Check compose ps
echo "--- Step 8: docker compose ps ---"
docker compose -f "$COMPOSE_FILE" ps

# Check both containers are Up
API_STATE=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | python3 -c "
import sys,json
data=sys.stdin.read().strip()
# docker compose ps --format json may output one JSON per line or a JSON array
lines=[l for l in data.splitlines() if l.strip()]
services={}
for line in lines:
    try:
        o=json.loads(line)
        services[o.get('Service','')]=o.get('State','')+'|'+o.get('Health','')
    except: pass
print(json.dumps(services))
" 2>/dev/null || echo "{}")
echo "Service states: $API_STATE"

# Verify api Up + healthy using docker ps
echo "Checking api container..."
API_UP=$(docker ps --filter "name=backend-api-1" --filter "name=task12-api-1" --format "{{.Status}}" 2>/dev/null | head -1 || true)
echo "api docker ps: $API_UP"

# Step 9: Engine sanity checks
echo "--- Step 9: Engine sanity ---"
echo "ss -tlnp | grep 50051:"
ss -tlnp | grep 50051 || { echo "50051 NOT listening"; FAIL=1; FAIL_REASON="engine not listening on 50051"; }

echo "vp-engine logs (tail 40):"
docker compose -f "$COMPOSE_FILE" logs --tail=40 vp-engine 2>&1 | tee /tmp/engine-logs.txt

# Check for fatal errors in engine logs
if grep -iE "fatal|error.*not found|no such file|cannot open|failed to load|missing.*cert|certificate.*not found|config.*error" /tmp/engine-logs.txt; then
  echo "WARNING: Potential fatal errors in engine logs (see above)"
  # Don't fail yet — engine might still be functional; FAIL on 50051 check above
fi

# Step 10: API health checks
echo "--- Step 10: API health checks ---"
API_LOCAL_OK=0
for i in $(seq 1 18); do
  if curl -fsS http://127.0.0.1:3000/health > /tmp/api-local-health.txt 2>&1; then
    echo "api local health OK (attempt $i):"
    cat /tmp/api-local-health.txt
    API_LOCAL_OK=1
    break
  fi
  echo "Attempt $i: api not ready, sleeping 5s..."
  sleep 5
done

if [ "$API_LOCAL_OK" -eq 0 ]; then
  FAIL=1
  FAIL_REASON="api local health failed after 90s"
fi

# ALB target group health (check via aws CLI)
echo "--- ALB target health ---"
TG_ARN="arn:aws:elasticloadbalancing:us-east-1:522814703714:targetgroup/vp-api-tg/eb12f5908a6dced2"
ALB_HEALTH=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$REGION" \
  --query "TargetHealthDescriptions[*].TargetHealth.State" --output text 2>/dev/null || echo "unknown")
echo "ALB target health state(s): $ALB_HEALTH"
if echo "$ALB_HEALTH" | grep -qv "healthy"; then
  echo "ALB not fully healthy yet — will check https endpoint"
fi

# https endpoint
echo "--- https://api.mindblisspower.com/health ---"
HTTPS_OK=0
for i in $(seq 1 6); do
  if curl -fsS https://api.mindblisspower.com/health > /tmp/api-https-health.txt 2>&1; then
    echo "https health OK (attempt $i):"
    cat /tmp/api-https-health.txt
    HTTPS_OK=1
    break
  fi
  echo "https attempt $i failed, sleeping 10s..."
  sleep 10
done
if [ "$HTTPS_OK" -eq 0 ]; then
  FAIL=1
  if [ -z "$FAIL_REASON" ]; then
    FAIL_REASON="https health check failed"
  fi
fi

# Engine listening check (re-verify)
ENGINE_LISTENING=$(ss -tlnp | grep 50051 || true)
if [ -z "$ENGINE_LISTENING" ]; then
  FAIL=1
  if [ -z "$FAIL_REASON" ]; then
    FAIL_REASON="vp-engine not listening on 50051"
  fi
fi

echo "=== Phase D: Decision ==="
if [ "$FAIL" -eq 0 ]; then
  echo "--- SUCCESS ---"
  systemctl disable mindbliss-vp-api 2>/dev/null || echo "mindbliss-vp-api already disabled or not found"
  systemctl disable mindbliss-vp-engine 2>/dev/null || echo "mindbliss-vp-engine already disabled or not found"
  echo "Final compose state:"
  docker compose -f "$COMPOSE_FILE" ps
  echo "=== DONE: Both containers healthy, systemd units disabled ==="
else
  echo "FAIL detected: $FAIL_REASON"
  rollback
fi
