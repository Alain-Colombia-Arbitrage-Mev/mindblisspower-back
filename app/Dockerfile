# syntax=docker/dockerfile:1.7
# Multi-stage Bun build. Build caches never enter the runtime image.
# Build: docker build -t 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:dev .
# Run:   docker run --env-file /etc/vicionpower/app.env -p 3000:3000 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api:dev

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS builder
WORKDIR /app

# Copy lockfile + manifest first for cache-friendly layer
COPY package.json bun.lock* ./
RUN --mount=type=cache,id=mindbliss-bun,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts

# Sanity check + freeze types
RUN bun run typecheck

FROM builder AS test
CMD ["sh", "-c", "bun test && bun run test:toolchain && bun scripts/pentest-http.ts"]

# Install into a clean stage: --production does not prune an existing node_modules.
# Omit optional adapter peers so Better Auth cannot reinstall the Drizzle CLI.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,id=mindbliss-bun,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --production --omit=peer && \
    test ! -f node_modules/drizzle-kit/package.json && test ! -f node_modules/esbuild/package.json

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS runtime
WORKDIR /app

# Non-root for defense-in-depth (the distroless image already runs as nonroot,
# but be explicit).
USER nonroot

COPY --from=production-deps --chown=nonroot:nonroot /app/node_modules  ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/src          ./src
COPY --from=builder --chown=nonroot:nonroot /app/package.json  ./
COPY --from=builder --chown=nonroot:nonroot /app/tsconfig.json ./

ENV NODE_ENV=production \
    PORT=3000 \
    PGBOUNCER=true

EXPOSE 3000

# Healthcheck used by Hetzner LB and docker
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["bun", "src/server.ts"]
