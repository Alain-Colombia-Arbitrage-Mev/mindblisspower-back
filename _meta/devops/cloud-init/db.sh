#!/usr/bin/env bash
# Bootstrap script for the AX52 dedicated DB host (Ubuntu 24.04).
# Run as root once after Hetzner provisioning + private network attach.
# Idempotent: safe to re-run.
set -euo pipefail

# ─── 1. Locale + UTC ──────────────────────────────────────────────────────────
locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8
timedatectl set-timezone UTC

# ─── 2. Tune kernel for Postgres on NVMe ──────────────────────────────────────
cat > /etc/sysctl.d/99-postgres.conf <<'EOF'
vm.swappiness                = 1
vm.overcommit_memory         = 2
vm.overcommit_ratio          = 95
vm.dirty_background_ratio    = 5
vm.dirty_ratio               = 10
kernel.shmmax                = 34359738368
kernel.shmall                = 8388608
fs.file-max                  = 1048576
net.core.somaxconn           = 4096
net.ipv4.tcp_keepalive_time  = 300
EOF
sysctl --system

# Disable transparent huge pages (Postgres prefers explicit hugepages or none)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# ─── 3. Install Postgres 17 + extensions + pgbackrest + pgbouncer ────────────
install -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

# TimescaleDB repo
curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor -o /etc/apt/keyrings/timescaledb.gpg
echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ noble main" \
  > /etc/apt/sources.list.d/timescaledb.list

apt-get update
apt-get install -y \
  postgresql-17 postgresql-contrib-17 \
  timescaledb-2-postgresql-17 timescaledb-tools \
  pgbackrest pgbouncer \
  ufw fail2ban prometheus-node-exporter prometheus-postgres-exporter

# TimescaleDB tune (ajusta postgresql.conf según RAM/CPU detectados)
# Ejecutar UNA VEZ después del install; nuestro postgresql.conf.tuned
# tiene valores explícitos así que esto es opcional.
# timescaledb-tune --quiet --yes

# ─── 4. NVMe data dir on /srv (assuming AX52 NVMe mounted at /srv) ────────────
systemctl stop postgresql@17-main
install -d -o postgres -g postgres -m 700 /srv/postgres/17/main
rsync -aHAX /var/lib/postgresql/17/main/ /srv/postgres/17/main/
mv /var/lib/postgresql/17/main /var/lib/postgresql/17/main.bak
ln -s /srv/postgres/17/main /var/lib/postgresql/17/main

# ─── 5. Drop in tuned config ──────────────────────────────────────────────────
install -d /etc/postgresql/17/main/conf.d
# Files are copied here by the deploy pipeline:
#   /etc/postgresql/17/main/conf.d/00-vicionpower.conf  (postgresql.conf.tuned)
#   /etc/postgresql/17/main/pg_hba.conf
#   /etc/pgbackrest/pgbackrest.conf

# ─── 6. Firewall ──────────────────────────────────────────────────────────────
ufw default deny incoming
ufw default allow outgoing
ufw allow from 10.0.0.0/16 to any port 5432 proto tcp
ufw allow from 10.0.0.0/16 to any port 6432 proto tcp   # PgBouncer
ufw allow from 10.0.0.0/16 to any port 9100 proto tcp   # node_exporter
ufw allow from 10.0.0.0/16 to any port 9187 proto tcp   # postgres_exporter
ufw allow 22/tcp
ufw --force enable

# ─── 7. pgbackrest stanza + initial full ──────────────────────────────────────
sudo -u postgres pgbackrest --stanza=vicionpower stanza-create
sudo -u postgres pgbackrest --stanza=vicionpower check
# First full backup happens via cron at next 03:00; trigger manually if needed:
# sudo -u postgres pgbackrest --stanza=vicionpower --type=full backup

# ─── 8. Start services ────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable --now postgresql@17-main
systemctl enable --now pgbouncer
systemctl enable --now prometheus-node-exporter
systemctl enable --now prometheus-postgres-exporter
systemctl enable --now fail2ban

echo "DB host ready. Now run 00-init.sql, then schema_mlm.sql, then start the migration playbook."
