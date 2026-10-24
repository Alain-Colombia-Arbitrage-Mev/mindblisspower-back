# Multi-stage build -> imagen scratch ~15MB
# Build:  docker build -f deployments/Dockerfile -t 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine:dev .
# Run:    docker run --env-file /etc/vp-engine/app.env -p 50051:50051 -p 9090:9090 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine:dev

# Stage 1: builder
FROM golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS builder

# Para CA certs y tzdata (timezones); copiamos al stage final.
RUN apk add --no-cache ca-certificates tzdata git

WORKDIR /src

# Cache mod download separadamente para layer caching óptimo.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static build con -trimpath y -ldflags strip.
ARG VERSION=dev
ARG COMMIT=unknown
ARG TARGETOS=linux
ARG TARGETARCH
ARG CMD=vp-engine
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
      -trimpath \
      -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o /app-bin \
      ./cmd/${CMD}

# Verificar que compiló estático (sin libs dinámicas).
# Usamos 'file' en vez de 'ldd' para compatibilidad con QEMU (cross-build arm64).
RUN apk add --no-cache file && \
    file /app-bin | grep -q "statically linked" || \
    (echo "ERROR: binario no es estático" && exit 1)

# Stage 2: runtime scratch
FROM scratch AS runtime

# Cosas mínimas para que el binario corra:
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /etc/passwd /etc/passwd
COPY --from=builder /app-bin /app-bin

# Non-root: nobody (uid 65534) ya está en /etc/passwd estándar Alpine.
USER 65534:65534

EXPOSE 50051 9090

# No HEALTHCHECK aqui; el proxy o systemd hace check a /health en puerto 9090.

ENTRYPOINT ["/app-bin"]
