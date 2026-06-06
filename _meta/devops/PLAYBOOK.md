# VicionPower — Hetzner DevOps Playbook

Production deployment for the architecture decided in the schema/migration docs:
Bun app on Hetzner Cloud, Postgres 17 on dedicated bare metal, pgbackrest backups, streaming replica, Cloudflare in front.

## 1. Topology

```
                 ┌──────────────────────────┐
                 │  Cloudflare (free tier)  │  ← TLS, DDoS, WAF
                 └────────────┬─────────────┘
                              │ public IPv4
                 ┌────────────┴─────────────┐
                 │  Hetzner Load Balancer   │  LB11, ~€5/mo
                 └────────────┬─────────────┘
                              │ private network (10.0.0.0/16)
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
        │ app-01    │   │ app-02    │   │ worker-01 │   ← CCX23, dedicated vCPU
        │ Bun+Hono  │   │ Bun+Hono  │   │ ROI/bonus │     8 vCPU / 32 GB
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              │               │               │
              └───────────────┼───────────────┘
                              │
                 ┌────────────┴─────────────┐
                 │  PgBouncer (on db-01)    │
                 └────────────┬─────────────┘
              ┌───────────────┼───────────────┐
              │                               │
        ┌─────┴──────┐                  ┌─────┴──────┐
        │ db-01      │ ───WAL stream──▶ │ db-02      │
        │ Postgres17 │                  │ replica    │
        │ AX52       │                  │ AX42       │
        │ (primary)  │                  │ (read-only)│
        └─────┬──────┘                  └────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ Hetzner Storage Box (1 TB)   │  ← pgbackrest full+incremental, WAL archive
   └──────────────────────────────┘

  ┌────────────┐
  │ redis-01   │  CX22, sessions cache, BullMQ
  └────────────┘
```

**Monthly cost (~€175):** 2× CCX23 (~€60), 1× CCX23 worker (~€30), AX52 primary (~€80), AX42 replica (~€50)... wait that's higher. Trim if needed: skip the read replica until traffic justifies it (~€125/mo without it). Storage Box (~€4) and Redis CX22 (~€4) are noise.

## 2. Provision sequence

```bash
# 0. Install hcloud CLI locally and authenticate
brew install hcloud
hcloud context create vicionpower

# 1. Network + firewall
hcloud network create --name vp-net --ip-range 10.0.0.0/16
hcloud network add-subnet vp-net --type cloud --network-zone eu-central --ip-range 10.0.1.0/24

hcloud firewall create --name vp-app-fw
hcloud firewall add-rule vp-app-fw --direction in --port 22  --protocol tcp --source-ips $(curl -s ifconfig.me)/32
hcloud firewall add-rule vp-app-fw --direction in --port 80  --protocol tcp --source-ips 0.0.0.0/0,::/0
hcloud firewall add-rule vp-app-fw --direction in --port 443 --protocol tcp --source-ips 0.0.0.0/0,::/0

# 2. App servers (cloud-init from cloud-init/app.yaml)
for n in 01 02; do
  hcloud server create \
    --name app-$n --type ccx23 --location nbg1 --image ubuntu-24.04 \
    --network vp-net --firewall vp-app-fw \
    --user-data-from-file cloud-init/app.yaml \
    --ssh-key vp-ops
done

# 3. Worker (same image as app, different systemd service)
hcloud server create --name worker-01 --type ccx23 --location nbg1 \
  --image ubuntu-24.04 --network vp-net --firewall vp-app-fw \
  --user-data-from-file cloud-init/app.yaml --ssh-key vp-ops

# 4. Redis
hcloud server create --name redis-01 --type cx22 --location nbg1 \
  --image ubuntu-24.04 --network vp-net --firewall vp-app-fw \
  --user-data-from-file cloud-init/redis.yaml --ssh-key vp-ops

# 5. DB primary — DEDICATED bare metal, ordered manually from
#    https://www.hetzner.com/dedicated-rootserver/ax52
#    AX52 / Ryzen 7950X3D / 64 GB DDR5 / 2× 1 TB NVMe
#    Provision Ubuntu 24.04, attach to vp-net via vSwitch.
ssh root@<ax52-ip> 'bash -s' < cloud-init/db.sh

# 6. Load balancer
hcloud load-balancer create --name vp-lb --type lb11 --location nbg1
hcloud load-balancer attach-to-network vp-lb --network vp-net
hcloud load-balancer add-target vp-lb --type server --server app-01 --use-private-ip
hcloud load-balancer add-target vp-lb --type server --server app-02 --use-private-ip
hcloud load-balancer add-service vp-lb --protocol http --listen-port 80 --destination-port 3000 \
  --health-check protocol=http,port=3000,interval=10s,timeout=5s,path=/health
```

## 3. Postgres tuning (AX52, 64 GB RAM)

See `postgres/postgresql.conf.tuned` for the full file. Key values:

| Setting | Value | Why |
|---|---|---|
| `shared_buffers` | `16GB` | 25 % of RAM, classic Postgres rule |
| `effective_cache_size` | `48GB` | Tells the planner how much of the working set fits in OS+PG cache |
| `work_mem` | `64MB` | Aggressive — we have few concurrent users, so big sorts don't multiply |
| `maintenance_work_mem` | `2GB` | VACUUM / CREATE INDEX speed |
| `max_wal_size` | `16GB` | Reduces checkpoint frequency on the 1 TB NVMe |
| `min_wal_size` | `2GB` | |
| `checkpoint_completion_target` | `0.9` | Spread I/O across the checkpoint window |
| `wal_compression` | `on` | Reduces archive size for pgbackrest |
| `random_page_cost` | `1.1` | NVMe is essentially equal-cost to seq |
| `effective_io_concurrency` | `200` | NVMe parallel I/O |
| `max_connections` | `200` | App goes through PgBouncer; raw connections stay low |
| `max_worker_processes` | `16` | Match physical cores |
| `max_parallel_workers` | `8` | |
| `max_parallel_workers_per_gather` | `4` | |

**ALWAYS-ON extensions:** `timescaledb`, `ltree`, `pgcrypto`, `btree_gist`, `pg_stat_statements`, `auto_explain`.

**TimescaleDB hypertables** (ver `_meta/migration/05_timescaledb.sql` y ADR 0001):
- `mlm.wallet_movement` — chunk 1mes, compresión a 30d
- `mlm.tree_event` — chunk 1mes, compresión a 60d
- `audit.activity_log` — chunk 1mes, compresión a 90d, **retention 5 años (Habeas Data)**
- 3 continuous aggregates: `mv_earnings_monthly`, `mv_network_growth_daily`, `mv_ledger_volume_daily`

## 4. Backups (pgbackrest → Hetzner Storage Box)

`postgres/pgbackrest.conf` defines the stanza. Cron schedule:

```cron
# /etc/cron.d/pgbackrest
0  3  * * 0   postgres   pgbackrest --stanza=vicionpower --type=full        backup
0  3  * * 1-6 postgres   pgbackrest --stanza=vicionpower --type=incremental backup
*/5 *  * * *  postgres   pgbackrest --stanza=vicionpower archive-push       check  # noop, watch
```

Recovery objective: **RPO ≤ 5 minutes** (WAL archived every 5 min) / **RTO ≤ 1 hour** (full restore from Storage Box).

Restore drill (run quarterly into a scratch instance):

```bash
pgbackrest --stanza=vicionpower --delta --type=time \
  --target='2026-04-27 03:30:00' restore
```

If the drill fails, backups are dead weight. Add it to the calendar.

## 5. Streaming replica (db-02)

```bash
# On db-02 as postgres user
pg_basebackup -h db-01.internal -D /var/lib/postgresql/17/main \
  -U replicator -v -P -X stream -R -S replica_db02

systemctl start postgresql@17-main
psql -c "SELECT pg_is_in_recovery();"   # → t
```

`primary_conninfo` and a replication slot (`replica_db02`) are recorded in `postgresql.auto.conf` by `-R`. Slot prevents WAL deletion if the replica falls behind, but **bounds the safety**: monitor `pg_replication_slots.restart_lsn` lag and alert if behind by more than 5 GB so the primary doesn't fill its WAL volume.

## 6. PgBouncer (on db-01)

Transaction pooling, on the DB host so app→bouncer is a unix socket but app→bouncer over private network works fine too.

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
vicionpower = host=127.0.0.1 port=5432 dbname=vicionpower

[pgbouncer]
listen_addr = 10.0.1.10        # private IP
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 25
max_client_conn = 1000
server_reset_query = DISCARD ALL
```

**Important:** in transaction mode, `prepare: false` in the postgres-js client (already set in `app/src/db/client.ts` when `PGBOUNCER=true`). Otherwise prepared statements break.

## 7. TLS

Cloudflare handles public TLS. Internal traffic is plain TCP on the private network (10.0.0.0/16) — Hetzner's vSwitch is isolated, but if you want defense-in-depth, configure Postgres with `ssl=on` and self-signed certs (or the free Let's Encrypt cert that Caddy can fetch via DNS-01).

`caddy/Caddyfile` is included in case you want to terminate TLS at the app tier instead of relying purely on Cloudflare. Recommended only if Cloudflare is bypassed.

## 8. Monitoring

- **postgres_exporter** on db-01 + db-02, scraped by Grafana Cloud (free tier) over Prometheus remote_write.
- **node_exporter** on every host.
- Dashboard alerts:
  - `pg_stat_activity` waiting count > 50
  - replication lag > 10 s
  - WAL archive lag > 10 min
  - free disk < 20 %
  - `pg_stat_statements` p95 > 200 ms on any of the top-10 query patterns
  - `mlm.v_wallet_balance_truth` returning any non-zero drift (custom query exporter)

The drift check is the only fintech-specific alert. It runs nightly at 04:00:

```cron
0 4 * * * postgres /usr/local/bin/check-drift.sh
```

`check-drift.sh` queries `mlm.v_wallet_balance_truth` and `mlm.v_tree_pv_truth`, posts a Slack webhook if any row has non-zero drift.

## 9. Deploy pipeline

`ci/deploy.yml` is the GitHub Actions workflow. Trigger: push to `main`.

```
build (Bun) → push image to GHCR → SSH to app-01,app-02 → docker pull + rolling restart
```

App container runs migrations on start (`bun auth:migrate` + a guard that compares `schema_mlm.sql` checksum against the DB and refuses to start if drift is detected).

## 10. Disaster recovery scenarios

| Scenario | Action | RTO |
|---|---|---|
| App server dies | Hetzner LB removes it from rotation, scale to a 3rd from snapshot | 5 min |
| Redis dies | Sessions invalidated; users re-login. BullMQ jobs replay from `tree_event` idempotency. | 10 min |
| db-02 (replica) dies | Re-`pg_basebackup` from db-01 | 1 h |
| db-01 (primary) dies, replica healthy | Promote db-02 (`pg_promote`), update PgBouncer host, point replica back-up | 15 min |
| db-01 disk corruption | Restore from pgbackrest into new AX52, replay WAL from Storage Box | 1 h |
| Hetzner NBG1 region outage | We're single-region. Cold standby in HEL1 with daily pgbackrest pull is the cheapest mitigation. | 4–8 h |

If you need < 1 h RTO across regions, that's a different cost tier (multi-region replica + Patroni). Defer until business case justifies it.

## 11. Security baseline

- SSH only on private key, root login disabled, fail2ban + UFW.
- `app_write` Postgres role can only INSERT/UPDATE on `mlm.*`, no DDL, no DELETE on `wallet_movement` or `transaction`.
- `app_admin` role only used by the worker process for `manual_adjustment` / `reversal` concept inserts; every such insert requires a corresponding `audit.activity_log` row (enforced by trigger — extension to add).
- Secrets stored in Hetzner Vault or 1Password CLI, never in repo. The `.env` on each host is rendered by cloud-init from a fetch-once URL.
- Hetzner has SOC 2 Type II + ISO 27001; sufficient for fintech operating in LATAM. For US/EU regulated payments, add encryption-at-rest with Customer-Managed Keys (Hetzner doesn't offer KMS, so this becomes app-side `pgcrypto` for `ssn_encrypted` etc).
