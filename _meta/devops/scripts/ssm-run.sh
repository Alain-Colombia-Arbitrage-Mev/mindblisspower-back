#!/usr/bin/env bash
# Uso: ssm-run.sh <instance-id> <script-file>
set -euo pipefail
INST="$1"; SCRIPT="$2"; REGION=us-east-1
B64=$(base64 -w0 "$SCRIPT")
PARAMS=$(printf '{"commands":["echo %s | base64 -d | sudo bash"]}' "$B64")
TMP=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/ssm-params-$$.json")
printf '%s' "$PARAMS" > "$TMP"
# On Windows/Git-Bash, convert /tmp path to Windows path for AWS CLI
if command -v cygpath >/dev/null 2>&1; then
  TMPWIN=$(cygpath -w "$TMP")
else
  TMPWIN="$TMP"
fi
CID=$(aws ssm send-command --region "$REGION" --document-name AWS-RunShellScript \
  --instance-ids "$INST" --parameters "file://$TMPWIN" --query 'Command.CommandId' --output text)
rm -f "$TMP"
for i in $(seq 1 60); do
  ST=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
done
echo "### $INST status=$ST"
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'StandardOutputContent' --output text
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'StandardErrorContent' --output text >&2
[ "$ST" = "Success" ]
