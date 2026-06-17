# Multi-stage Bun build. Final image ~120 MB.
# Build: docker build -t 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:dev .
# Run:   docker run --env-file /etc/vicionpower/app.env -p 3000:3000 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:dev

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.1-debian AS builder
WORKDIR /app

# Copy lockfile + manifest first for cache-friendly layer
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src

# Sanity check + freeze types
RUN bun run typecheck

# Prune dev deps for the runtime image
RUN bun install --frozen-lockfile --production

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.1-distroless AS runtime
WORKDIR /app

# Non-root for defense-in-depth (the distroless image already runs as nonroot,
# but be explicit).
USER nonroot

COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/src         ./src
COPY --from=builder --chown=nonroot:nonroot /app/package.json ./

ENV NODE_ENV=production \
    PORT=3000 \
    PGBOUNCER=true

EXPOSE 3000

# Healthcheck used by Hetzner LB and docker
HEALTHCHECK --interval=10s --timeout=2s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["bun", "src/server.ts"]
