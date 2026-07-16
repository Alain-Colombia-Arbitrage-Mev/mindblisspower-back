#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/bin:/usr/bin"

echo "=== Phase A: Prepare ==="

# 1. ECR login
echo "--- ECR login ---"
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 522814703714.dkr.ecr.us-east-1.amazonaws.com
echo "ECR login OK"

# 2. Pull image
echo "--- Pulling image ---"
docker pull 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:437bf36180f725c9ce85c0b605d3eb8ed90f1dd3
echo "Image pull OK"

# 3. Generate env file from SSM
echo "--- Generating env file from SSM ---"
install -d -m 700 /run/vicionpower
: > /run/vicionpower/api.env
chmod 600 /run/vicionpower/api.env
aws ssm get-parameters-by-path \
  --region us-east-1 \
  --path /vicionpower/prod/api/ \
  --with-decryption \
  --query 'Parameters[].[Name,Value]' \
  --output text | \
  while IFS="$(printf '\t')" read -r n v; do
    [ -n "$n" ] && printf '%s=%s\n' "${n#/vicionpower/prod/api/}" "$v" >> /run/vicionpower/api.env
  done
ENV_COUNT=$(wc -l < /run/vicionpower/api.env)
echo "Env vars written: $ENV_COUNT"

# 4. Record rollback state
echo "--- Current api service state ---"
systemctl is-active mindbliss-vp-api || true
