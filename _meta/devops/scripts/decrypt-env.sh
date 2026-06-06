#!/usr/bin/env bash
# /usr/local/bin/decrypt-env.sh
# Decrypt sops-encrypted secrets file → /etc/vicionpower/app.env (mode 600).
# Run by systemd ExecStartPre on each app host. Idempotent.
#
# Required:
#   - sops + age installed (apt: sops; age binary from GitHub releases)
#   - Host age key at /etc/vicionpower/age.key (mode 400, root:root)
#   - Encrypted file at /etc/vicionpower/secrets.enc.yaml (committed in repo,
#     pulled by the deploy pipeline before this script runs)
set -euo pipefail

KEY=/etc/vicionpower/age.key
ENC=/etc/vicionpower/secrets.enc.yaml
OUT=/etc/vicionpower/app.env

[[ -r "$KEY" ]] || { echo "Missing age key at $KEY" >&2; exit 1; }
[[ -r "$ENC" ]] || { echo "Missing encrypted secrets at $ENC" >&2; exit 1; }

export SOPS_AGE_KEY_FILE="$KEY"

umask 077
sops --decrypt --output-type dotenv "$ENC" >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"
chown deploy:deploy "$OUT"
chmod 600 "$OUT"

echo "Decrypted secrets to $OUT"
