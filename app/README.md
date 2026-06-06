# VicionPower app

Bun + Hono + Better Auth + Drizzle (Postgres). Designed to run as 2× CCX23 instances on Hetzner behind a Load Balancer.

## Setup

```bash
cp .env.example .env  # fill in real values
bun install

# Better Auth creates auth.* tables. Run AFTER schema_mlm.sql is applied.
bun auth:migrate

# Verify Drizzle types match the DDL (no migration should be generated).
bun db:generate

bun dev
```

## Architecture decisions

- **Identity split.** `auth.user` (Better Auth) ↔ `mlm.person` (KYC) ↔ `mlm.affiliate` (tree position). A signup creates `auth.user` + `mlm.person` automatically via the `databaseHooks.user.create.after` hook in `src/auth.ts`. Tree placement is a separate authenticated step (`POST /api/affiliate/place`).
- **No per-MAU billing.** Better Auth costs nothing per user; the only cost is rows in `auth.session` (TTL 7 days) and `auth.account` (one row per OAuth link).
- **Idempotency at the boundary.** Every business mutation (`postTransaction`, `registerPvCredit`) requires an `externalRef`. Database `UNIQUE` constraints make retries safe.
- **Lock ordering.** `placeAffiliate` locks the parent row first, then verifies the leg is empty inside the same transaction. Two concurrent placements at the same empty leg cannot both succeed.
- **Set-based PV propagation.** PV credits are appended to `mlm.tree_event`; the `trg_apply_tree_event` trigger (in DDL) fans out to ancestor aggregates in one ordered UPDATE — no application-side recursion.

## What's NOT here

- Frontend (Next/Astro/SPA) — this is the API layer only.
- Background workers for ROI / binary bonus runs — those are separate Bun processes pulling from BullMQ on Redis. Same `src/db/client.ts`, different entrypoint.
- KYC document upload — goes to S3-compatible Hetzner Storage Box; only metadata in `mlm.person`.

## Production checklist

- [ ] `BETTER_AUTH_SECRET` is a real 32-byte random string (`openssl rand -base64 32`).
- [ ] `DATABASE_URL` points to PgBouncer (port 6432), not directly to Postgres.
- [ ] `PGBOUNCER=true` is set so `prepare: false` is used.
- [ ] Cloudflare in front, terminating TLS; app listens on private network.
- [ ] Resend domain verified for the `from:` address.
- [ ] OAuth redirect URIs registered with Google for the production hostname.
