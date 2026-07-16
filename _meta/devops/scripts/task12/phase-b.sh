#!/usr/bin/env bash
# Phase B: cutover — brief api blip
set -euo pipefail

IMAGE_TAG="a31cc2c6f3cd70133f32aa40d2f51eb982695727"
REGISTRY="522814703714.dkr.ecr.us-east-1.amazonaws.com"
COMPOSE_FILE="/opt/vicion/compose/server2.yml"

echo "=== Phase B: Cutover ==="

# Step 6: Stop old services
echo "--- Step 6: Stop old engine + remove canary ---"
systemctl stop mindbliss-vp-engine || echo "mindbliss-vp-engine already stopped"
docker rm -f vp-api-canary && echo "vp-api-canary removed" || echo "vp-api-canary not found or already removed"

# Step 7: Compose up
echo "--- Step 7: docker compose up -d ---"
export IMAGE_TAG REGISTRY
docker compose -f "$COMPOSE_FILE" up -d
echo "Compose up OK"
docker compose -f "$COMPOSE_FILE" ps

echo "=== Phase B complete ==="
