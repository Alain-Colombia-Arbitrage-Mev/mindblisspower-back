# Secrets management — sops + age

We do **not** use Hetzner Vault, AWS Secrets Manager, or HashiCorp Vault Cloud.
Reason: at this scale (one production environment, two app hosts), `sops + age` gives 95 % of the value at 0 % of the cost — encrypted secrets live alongside the infra-as-code in git, and only the live hosts (plus designated ops humans) can decrypt.

If/when we exceed ~10 services or need dynamic credentials (per-pod DB users, short-lived OAuth tokens), upgrade to Vault. Until then, this is right-sized.

## One-time setup

### 1. Install on your laptop
```bash
brew install sops age   # macOS
# or apt install sops; download age from https://github.com/FiloSottile/age/releases
```

### 2. Generate ops key (one per human ops contact)
```bash
age-keygen -o ~/.config/sops/age/keys.txt
# Output prints "Public key: age1...". Add that pubkey to .sops.yaml under
# the "ops" recipients for every environment you should be able to decrypt.
```

### 3. Generate per-host keys
On each prod app host (run via cloud-init or first-boot ssh):
```bash
sudo install -d -m 700 -o root -g root /etc/vicionpower
sudo age-keygen -o /etc/vicionpower/age.key
sudo chmod 400 /etc/vicionpower/age.key
sudo grep -oE 'age1[a-z0-9]+' /etc/vicionpower/age.key | tail -1   # pubkey
```
Add the host pubkey to `.sops.yaml` under the matching environment.

### 4. Encrypt the production file
```bash
cp secrets.example.yaml production.enc.yaml
$EDITOR production.enc.yaml          # fill values
sops -e -i production.enc.yaml       # encrypts in-place
git add production.enc.yaml          # safe to commit, encrypted
```

### 5. Verify a host can decrypt
```bash
ssh app-01 'SOPS_AGE_KEY_FILE=/etc/vicionpower/age.key sops -d /opt/vicionpower/secrets/production.enc.yaml | head -3'
```

## Day-to-day

### Edit a secret
```bash
sops production.enc.yaml             # opens decrypted in $EDITOR; re-encrypts on save
```

### Rotate a key (e.g., person leaving the team)
```bash
# 1. Add new recipient to .sops.yaml, remove the leaving one
# 2. Re-key all encrypted files in one shot:
sops updatekeys production.enc.yaml staging.enc.yaml dev.enc.yaml
# 3. Commit. The leaving person's key can no longer decrypt.
```

### Pull onto hosts at deploy time
The deploy pipeline (`ci/deploy.yml`) does:
```
git pull → sops -d production.enc.yaml > /etc/vicionpower/app.env → systemctl restart vicionpower-app
```
The `decrypt-env.sh` wrapper handles this exact flow. systemd's `ExecStartPre` runs it before each start so a key rotation just requires `systemctl restart`.

## What goes in here vs not

**In sops:** API keys, DB passwords, JWT signing secrets, encryption keys, SMTP creds, OAuth client secrets — anything that, if leaked, lets an attacker do something they shouldn't.

**Not in sops:** TLS certs (use Let's Encrypt + Caddy / Cloudflare), public OAuth client IDs (committed plain in `.env.example`), feature flag values (use a config service), host private SSH keys (live on the host, never in repo).

## Threat model

- **Repo leak (read-only access):** attacker sees ciphertext only, useless without an age private key.
- **Single host compromise:** attacker reads `/etc/vicionpower/age.key` (mode 400 root) and decrypts secrets for that environment. Mitigation: restrict outbound network egress; rotate keys quarterly; alert on `/etc/vicionpower/age.key` reads via auditd.
- **Ops laptop compromise:** attacker decrypts every environment they had access to. Mitigation: laptop encryption (FileVault/LUKS), age key passphrase-protected (`age-keygen -o key.txt` + `age -p` for passphrase wrap), MFA on git host.

This is not perfect. It's right-sized. If you handle PCI / SOC2 / regulated payments, replace with Vault.
