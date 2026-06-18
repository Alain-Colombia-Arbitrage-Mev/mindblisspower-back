#!/usr/bin/env bash
set -euo pipefail
REGION=us-east-1
POLICY_FILE="$(dirname "$0")/lifecycle-policy.json"
for repo in vp/api vp/vp-engine vp/vp-payments; do
  aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1 \
    || aws ecr create-repository \
         --repository-name "$repo" \
         --region "$REGION" \
         --image-tag-mutability IMMUTABLE \
         --image-scanning-configuration scanOnPush=true >/dev/null
  aws ecr put-lifecycle-policy \
    --repository-name "$repo" \
    --region "$REGION" \
    --lifecycle-policy-text "file://$POLICY_FILE" >/dev/null
  echo "OK: $repo"
done
