# Multi-stage build -> imagen scratch ~15MB
# Build:  docker build -f deployments/Dockerfile -t 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine:dev .
# Run:    docker run --env-file /etc/vp-engine/app.env -p 50051:50051 -p 9090:9090 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine:dev

# Stage 1: builder
FROM golang:1.25-alpine AS builder

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
ARG TARGETARCH=arm64
ARG CMD=vp-engine
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
      -trimpath \
      -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o /app-bin \
      ./cmd/${CMD}

# Verificar que compiló estático (sin libs dinámicas).
RUN ldd /app-bin 2>&1 | grep -q "not a dynamic executable" || \
    (echo "ERROR: binario no es estático" && exit 1)

# Stage 2: runtime scratch
FROM scratch

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
