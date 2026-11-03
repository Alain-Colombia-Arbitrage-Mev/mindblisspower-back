# Private gRPC transport spike — synthetic and local only

This directory is an isolated local test, **not deployment or financial certification**.
It never reads the project's `.env.local`, connects to a real database, contacts
Stripe, starts Chatwoot, changes DNS, or deploys Cloudflare resources. Do not run
`wrangler deploy` or `--remote` against this fixture.

## Actual Core/Go result — 26 October 2026

`run-core-local.mjs` tests the actual Core Worker/Container classes, production
Bun transport functions, actual Go Engine binary and actual Go JWT verifier.
It creates/seeds its own ephemeral TLS PostgreSQL container, then uses a
SELECT-only `engine_reader`. It may pause/remove only that strictly named
synthetic database. Its attempted `PostTransaction` is a negative test: the
recovery guard must reject it and the synthetic ledger must not change.

The complete local run exited 0 using Wrangler 4.152.0, SDK 0.3.7, Bun 1.4.4 and
Node 24.16.0 in a Linux Docker runner with Docker Desktop:

- Private native Engine readiness reached; public/unknown routes rejected.
- Actual `GetWalletBalance` returned seeded 123.45; eight concurrent reads,
  a 512 KiB protobuf request, reconnection and RPC deadline cancellation passed.
- Untrusted client certificate, wrong server name and wrong server CA rejected.
- Actual Go `NewBetterAuthVerifier` verified a synthetic RS256 JWT using JWKS
  through private HTTPS interception; removing the injected CA rejected. The
  JWT/JWKS issuer is a fixture, not the real Better Auth server.
- A fresh channel rejected while the synthetic DB was paused. Wallet hash,
  movement/sale counts, SELECT-only privileges and zero lingering `PgSleep`
  remained unchanged. The fixture's Containers/sidecars/PG were removed afterward.

Sanitized reports are written to ignored `runtime/core-last-result.json`. The
normalized runner records `financialCorrectnessCertified:false` and before/after
snapshots. The normalized versioned runner passed at 2026-10-26 05:08 UTC;
its report SHA256 was
`73ae657169f2ace3d8d9d61d3be80566d75654dda6e7a48d2e7439e039284cc2`.

This proves local transport/dependency failure handling, **not** Cloudflare's
remote network, realistic load, binary-tree/rank formulas, payout correctness or
startup invariants. Engine `/ready` with the scheduler disabled does not certify
financial invariants. Do not lift production gates from this local evidence.

The helper always emits JSON on both successful verification and expected
rejection; the probe explicitly overrides the Bun base image's `PORT` to 9095.

## Candidate transport

The existing Bun gRPC client keeps TLS and HTTP/2. A loopback TCP proxy sends the
opaque TLS bytes through a binary WebSocket to a virtual outbound hostname on
port 80. The outbound handler calls only the named private Engine Durable Object;
that object opens only its configured container port 50051 with
`ctx.container.getTcpPort(50051).connect(...)`. The Worker does not parse gRPC,
terminate its TLS, select a request-supplied destination, or publish an Engine URL.

The relay has a 16 KiB payload limit per frame and a stop-and-wait acknowledgement
in each direction. An ACK follows completed TCP writing, not mere message receipt.
It rejects extra DATA while writing, unsolicited ACKs, text, oversize and unknown
frames; cancellation, a 10-second idle timeout and a 60-second hard lifetime close
both ends. These short bounds are **test settings**, not production pool tuning.
There is no replay/resume of an interrupted gRPC operation.

`SyntheticClient.outboundByHost = {...}` must be assigned **after** its class.
The Containers 0.3.7 setter registers handlers; a static class field shadows that
setter and the private probe returns 520 instead of reaching the handler.

## Historical Node HTTP2 spike (25 October 2026)

Wrangler 4.152.0, Containers SDK 0.3.7, Bun 1.4.4, Node 24.16.0 container,
Linux/WSL with Docker Desktop. Unit runner: Node 24.16.0 on Windows.

- 10 relay unit tests: bounded output, delayed ACK, cancellation, idle and hard
  deadline, protocol violations and blocked-writer rejection.
- 8 local `workerd`/Docker assertions: public Engine route rejected; private
  outbound HTTP reached; valid mTLS HTTP/2 request and 512 KiB request returned
  identical gRPC-framed bytes with ALPN `h2` and `grpc-status: 0` trailers;
  absent client certificate, untrusted client certificate, wrong server name
  and wrong server trust root could not obtain a valid gRPC response.

That older synthetic server is **Node HTTP/2**, not the actual Go Engine. It proved
byte transport and certificate rejection across actual locally simulated
outbound interception and private Container TCP, **not the real Engine's JWT,
permissions, protobuf methods, database behavior or readiness**. It is not a
remote Cloudflare, production topology, durability, concurrency or load test.
Do not set `CORE_NETWORK_VERIFIED=true` from this evidence alone.

## Reproduction

Pure protocol tests need no packages or network:

```sh
node --test deploy/cloudflare/transport-spike/framed-relay.test.mjs deploy/cloudflare/transport-spike/synthetic-docker-proxy.test.mjs
```

The integration harness requires Linux/WSL, Docker, OpenSSL and the two cached
base images named in the Dockerfiles. It imports Wrangler from the existing core
tools by default. When their native packages are Windows binaries, install the
same pinned Wrangler in an isolated Linux tools directory and point
`SPIKE_TOOL_ROOT` at that directory (its `node_modules` must contain Wrangler).
An already prepared ignored tools directory exists locally under `runtime/linux-tools`.

```sh
docker build --network none -f deploy/cloudflare/transport-spike/Dockerfile.real-go -t mindbliss/cf-core-go-test:20261025 .
SPIKE_TOOL_ROOT=/absolute/path/to/linux-tools \
  node deploy/cloudflare/transport-spike/run-core-local.mjs
```

The harness generates one-day synthetic PKI under ignored `runtime/`, passes only
synthetic endpoint keys to its fixture, and stores sanitized results there.
Its fixture combines endpoint keys for convenience; production must inject
separate minimum credentials. It never exports the generated CA private key to
Worker/container environment. Docker build ignores runtime files and PKI.
After stopping Wrangler it removes only its strictly validated synthetic
container/sidecar names. Built images and ignored synthetic PKI remain reusable.

### Docker Desktop/WSL local gateway workaround

The reset `dial tcp 192.168.65.254:<port>: connect: connection refused` matches
[upstream #15257](https://github.com/cloudflare/workers-sdk/issues/15257). It is a
local network-namespace problem, not an mTLS rejection.

The verified setup runs Wrangler inside a Linux Docker runner with
`--network host`, sharing the Docker VM's actual bridge namespace. Opting in with
`SPIKE_DOCKER_GATEWAY=172.17.0.1` verifies that IP against
`docker network inspect bridge`, then starts a mode-0600 Unix Docker socket proxy.
It adds `--gateway-ip` only to this fixture's exact sidecar create requests.
Tests ensure unrelated container commands remain byte-identical. No DNS/daemon
changes, Docker/WSL restarts, public relay, TLS bypass or production import occur.
Do not use it in a WSL namespace whose bridge differs from the daemon's bridge.

`Dockerfile.runner` reproduces the tested runner from cached portal tooling and
the cached engine CA bundle. Stage existing Linux Docker CLI/buildx binaries at
ignored `runtime/docker-cli-local` and `runtime/docker-buildx-local`. Its ignore
file excludes other runtime files, including PKI:

```sh
docker build --network none -f deploy/cloudflare/transport-spike/Dockerfile.runner -t mindbliss/cf-core-runner-test:20261025 deploy/cloudflare/transport-spike
```

For this Windows checkout, mount `D:\vicionpower\backend` read-only at
`/run/desktop/mnt/host/d/vicionpower/backend`; mount only its transport-spike
`runtime` directory read-write and `/var/run/docker.sock`. Use `--network host`,
`SPIKE_TOOL_ROOT=/app`, `SPIKE_DOCKER_GATEWAY=172.17.0.1`, and an unexpired
`SPIKE_PKI_DIR` under that Linux runtime path; execute `run-core-local.mjs` at the
same Linux path. Matching the Docker VM host path is required for synthetic PG
certificate bind mounts. This runner lacks OpenSSL: generate synthetic PKI with
the Linux/OpenSSL setup first. The older `run-local.mjs` is historical; use
`run-core-local.mjs` for current real-Go acceptance evidence.

## Required before production integration

1. Adapt the real API gRPC client to a loopback socket while keeping the real
   expected TLS server name, trusted CA, client certificate and `rejectUnauthorized`.
   Never change its URL to plaintext or depend on Compose DNS.
2. Integrate only the fixed private DO/port entrypoint, close the public route,
   keep the existing four-Container topology, and enforce service-specific
   identities. Confirm actual Go readiness separately from a port accepting TCP.
3. Run actual Bun-to-Go calls with synthetic identity/data, including expired
   certificates, auth failures, RPC cancellation/deadlines, disconnect/reconnect,
   parallel calls, large streams, limits and resource measurements.
4. Validate the exact staging topology and private route denial before the
   deployment gate changes. No financial jobs or account linking is authorized
   by the transport test.

Official references checked for the spike:
[private TCP Container ports](https://developers.cloudflare.com/containers/api/durable-object-container/),
[outbound interception and local sidecar](https://developers.cloudflare.com/containers/configuration/outbound-traffic/),
[service-binding TCP](https://developers.cloudflare.com/workers/runtime-apis/handlers/connect/),
[Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/),
[non-functional node:http2 stub](https://developers.cloudflare.com/workers/runtime-apis/nodejs/),
[local development](https://developers.cloudflare.com/containers/guides/local-dev/).
