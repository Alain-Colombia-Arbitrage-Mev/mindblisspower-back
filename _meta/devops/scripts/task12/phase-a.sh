#!/usr/bin/env bash
# Phase A: prepare — no disruption
set -euo pipefail

IMAGE_TAG="a31cc2c6f3cd70133f32aa40d2f51eb982695727"
REGISTRY="522814703714.dkr.ecr.us-east-1.amazonaws.com"
REGION="us-east-1"
COMPOSE_FILE="/opt/vicion/compose/server2.yml"
ENV_DIR="/run/vicionpower"

echo "=== Phase A: Prepare ==="

# Step 1: ECR login
echo "--- Step 1: ECR login ---"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
echo "ECR login OK"

# Step 2: Ship compose file (base64-encoded content decoded inline)
echo "--- Step 2: Ship compose file ---"
mkdir -p /opt/vicion/compose
printf '%s' 'c2VydmljZXM6CiAgYXBpOgogICAgaW1hZ2U6ICR7UkVHSVNUUll9L3ZwL2FwaToke0lNQUdFX1RBR30KICAgIHJlc3RhcnQ6IHVubGVzcy1zdG9wcGVkCiAgICBuZXR3b3JrX21vZGU6IGhvc3QKICAgIGVudl9maWxlOiBbL3J1bi92aWNpb25wb3dlci9hcGkuZW52XQogICAgaGVhbHRoY2hlY2s6CiAgICAgIHRlc3Q6IFsiQ01EIiwgImJ1biIsICItZSIsICJmZXRjaCgnaHR0cDovLzEyNy4wLjAuMTozMDAwL2hlYWx0aCcpLnRoZW4ocj0+cHJvY2Vzcy5leGl0KHIub2s/MDoxKSkuY2F0Y2goKCk9PnByb2Nlc3MuZXhpdCgxKSkiXQogICAgICBpbnRlcnZhbDogMTBzCiAgICAgIHRpbWVvdXQ6IDJzCiAgICAgIHJldHJpZXM6IDMKICAgICAgc3RhcnRfcGVyaW9kOiAxNXMKICAgIHN0b3BfZ3JhY2VfcGVyaW9kOiAyMHMKICB2cC1lbmdpbmU6CiAgICBpbWFnZTogJHtSRUdJU1RSWX0vdnAvdnAtZW5naW5lOiR7SU1BR0VfVEFHfQogICAgcmVzdGFydDogdW5sZXNzLXN0b3BwZWQKICAgIG5ldHdvcmtfbW9kZTogaG9zdAogICAgdXNlcjogIjAiCiAgICBlbnZfZmlsZTogWy9ydW4vdmljaW9ucG93ZXIvdnAtZW5naW5lLmVudl0KICAgIHZvbHVtZXM6CiAgICAgIC0gL2V0Yy92cC1lbmdpbmUvdGxzOi9ldGMvdnAtZW5naW5lL3RsczpybwogICAgc3RvcF9ncmFjZV9wZXJpb2Q6IDIwcwo=' | base64 -d > "$COMPOSE_FILE"
echo "Compose file written to $COMPOSE_FILE:"
cat "$COMPOSE_FILE"

# Step 3: Generate env files from SSM
echo "--- Step 3: Generate env files ---"
mkdir -p "$ENV_DIR"

# api.env
rm -f "$ENV_DIR/api.env"
touch "$ENV_DIR/api.env"
chmod 600 "$ENV_DIR/api.env"
aws ssm get-parameters-by-path \
  --path "/vicionpower/prod/api/" \
  --with-decryption \
  --query "Parameters[*].[Name,Value]" \
  --output text \
  --region "$REGION" | while IFS=$'\t' read -r name value; do
    key="${name##*/vicionpower/prod/api/}"
    printf '%s=%s\n' "$key" "$value" >> "$ENV_DIR/api.env"
  done
API_COUNT=$(wc -l < "$ENV_DIR/api.env")
echo "api.env: $API_COUNT vars"

# vp-engine.env
rm -f "$ENV_DIR/vp-engine.env"
touch "$ENV_DIR/vp-engine.env"
chmod 600 "$ENV_DIR/vp-engine.env"
aws ssm get-parameters-by-path \
  --path "/vicionpower/prod/vp-engine/" \
  --with-decryption \
  --query "Parameters[*].[Name,Value]" \
  --output text \
  --region "$REGION" | while IFS=$'\t' read -r name value; do
    key="${name##*/vicionpower/prod/vp-engine/}"
    printf '%s=%s\n' "$key" "$value" >> "$ENV_DIR/vp-engine.env"
  done
ENGINE_COUNT=$(wc -l < "$ENV_DIR/vp-engine.env")
echo "vp-engine.env: $ENGINE_COUNT vars"

# Step 4: Pull images
echo "--- Step 4: Pull images ---"
export IMAGE_TAG REGISTRY
docker compose -f "$COMPOSE_FILE" pull
echo "Images pulled OK"

# Step 5: Record rollback state
echo "--- Step 5: Rollback state snapshot ---"
echo "systemctl status:"
systemctl is-active mindbliss-vp-api || true
systemctl is-active mindbliss-vp-engine || true
echo "canary container:"
docker ps --filter name=vp-api-canary
echo "=== Phase A complete ==="
