# 0006 — gRPC + connectrpc + buf para comunicación TS ↔ Go

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

ADR 0002 establece dos servicios polyglot: `vp-api` (TypeScript) y `vp-engine` (Go). Necesitan comunicarse para operaciones síncronas críticas:

- `vp-api` recibe `POST /api/transactions` → debe llamar `vp-engine.Ledger.PostTransaction()` y devolver el resultado.
- `vp-api` admin dispara `RunBonusJob` → llama `vp-engine.BonusEngine.RunDaily()` y devuelve summary.
- `vp-api` consulta balance fresco → puede ir directo a Postgres o vía `vp-engine.Ledger.GetBalance()` (cache + invalidation).

Restricciones:
- **Tipos sincronizados** entre TS y Go — drift = bug en runtime difícil de cazar.
- **Latencia interna baja** (objetivo p99 < 5ms en red privada Hetzner).
- **Streaming opcional** para `BatchPostTransactions`, `StreamMovements` futuros.
- **mTLS para autenticar caller** (ADR 0002 §4) sin overhead de validation extra.

## Decision

**gRPC sobre HTTP/2 con connectrpc + buf para codegen.**

Stack:
- **Definición:** archivos `.proto` en repo separado `vp-proto/`, source of truth.
- **Codegen:** `buf generate` produce stubs TS (`@connectrpc/connect`) y Go (`connectrpc.com/connect`).
- **Servidor (vp-engine):** connectrpc Go handler montado en `chi` router para coexistir con `/health` y `/metrics`.
- **Cliente (vp-api):** connectrpc Node client, usa el mismo HTTP/2 transport.
- **Wire format:** binary protobuf en producción; JSON opcional para debugging local.
- **Transport security:** mTLS entre `vp-api` y `vp-engine`, certs firmados por CA interna.

Estructura `vp-proto/`:
```
proto/
└── vicionpower/
    └── v1/
        ├── ledger.proto         # service Ledger { PostTransaction, ReverseTransaction, GetBalance }
        ├── bonus_engine.proto   # service BonusEngine { RunDaily, GetRunStatus }
        ├── tree.proto           # service Tree { PlaceAffiliate, GetUpline, GetDownline }
        ├── common.proto         # ActorContext, Money, Pagination, etc.
        └── chain_watcher.proto  # service ChainWatcher { (mostly internal events) }
buf.yaml
buf.gen.yaml
README.md
```

## Consequences

### Positivas

- **Type safety end-to-end.** `buf generate` falla en CI si los stubs no se regeneran, garantizando que TS y Go nunca drifteen.
- **Latencia ~2-3x menor que JSON+REST.** Binary protobuf + HTTP/2 multiplexed connections + mTLS keep-alive. Medido p99 ~1-2ms en red privada Hetzner para payloads <4KB.
- **Streaming nativo** sin reinventar SSE/WebSockets.
- **connectrpc gana sobre grpc-go nativo:** sirve gRPC + gRPC-Web + Connect protocol simultáneamente desde el mismo handler. Si en el futuro un cliente browser necesita llamar directo, ya está habilitado sin cambiar nada.
- **Schema evolution:** protobuf field numbers permiten agregar campos sin breaking compatibility. Versionado con `v1/`, `v2/` paths cuando hay breaking changes.
- **Observabilidad:** tracing propagation por headers gRPC; métricas RED (rate, errors, duration) por método salen "gratis" con OTel interceptors.
- **buf herramienta es excelente:** `buf lint`, `buf breaking` (detecta cambios incompatibles), `buf format`, registry para compartir entre repos.

### Negativas

- **Curva de aprendizaje** para devs sin experiencia protobuf/gRPC. ~1 semana para que el equipo escriba .proto idiomatic.
- **Debugging menos directo** que HTTP/JSON. `grpcurl` cumple pero no tan trivial como `curl localhost:3000`. Mitigación: connectrpc también acepta JSON sobre el mismo endpoint para debug local.
- **Dependencia de buf** (herramienta open source pero comercialmente backed). Si Buf Inc. desaparece, `protoc` directo cubre lo esencial — solo perderíamos el lint/breaking detection.
- **mTLS añade complejidad de cert lifecycle.** Renovación de certs internos (cada 90 días con cert-manager-equivalente o anual con CA interna) es un proceso operativo extra. Mitigación: documentado en runbook + automatizable con scripts.
- **Reverse-proxying gRPC** detrás de Cloudflare es posible pero no trivial. Por ahora `vp-engine` no tiene endpoint público — irrelevante.

### Neutras

- Code splitting: `vp-proto/` es repo separado. PR coordination cuando se cambia un .proto: regenerar stubs + abrir 2 PRs (TS y Go) para consumir. CI lo facilita con `buf push` a registry.

## Alternatives considered

### REST + JSON sobre HTTP/1.1 o HTTP/2

**Rechazado.**
- Sin codegen tipado garantizado. OpenAPI ayuda pero requires diligencia humana — no es un gate enforced.
- Latencia ~2-3x peor: JSON es texto, requiere parse/stringify por request, sin multiplexing eficiente en HTTP/1.1.
- Streaming requires SSE o WebSocket — protocolos separados, manejo distinto.

OK para cliente-servidor frontend↔BFF (donde está). No para servicio-a-servicio crítico.

### tRPC

**Rechazado.** Excelente para TS↔TS, pero **no es cross-language**. Sin codegen para Go.

### GraphQL (e.g. Apollo Federation)

**Rechazado.**
- GraphQL excede para servicio-a-servicio interno donde sabemos exactamente qué necesitamos.
- N+1 problem (clásico) requiere DataLoader patterns extra.
- Complejidad operacional (gateway federation, schema stitching).
- Sin streaming nativo hasta GraphQL subscriptions, que añaden websocket layer.

Útil para frontend↔BFF cuando el cliente quiere flexibilidad. No es nuestro caso.

### gRPC nativo (grpc-go + grpc-js)

**Considerado, perdió frente a connectrpc.**
- grpc-js (Node) tiene historia de bugs y rendimiento inferior a connectrpc.
- grpc-go nativo es excelente, pero connectrpc Go es 100% compatible y más ergonómico.
- connectrpc añade compatibilidad con gRPC-Web sin trabajo extra (futuro-proofing si un browser cliente lo necesita).

Connectrpc ES gRPC, solo con mejor DX.

### Apache Thrift

**Rechazado.** Tecnología sólida (Facebook), pero ecosistema Go/Node inferior al de gRPC. Comunidad menos activa en últimos años.

### Apache Avro + custom transport

**Rechazado.** Avro es excelente para schema evolution en mensajes (ver ADR 0007 para NATS — usamos JSON ahí, pero Avro fue evaluado). Para RPC síncrono, gRPC es estándar de industria.

### Plain HTTP/2 + ProtoBuf manual

**Rechazado.** Reinventaríamos gRPC mal. Sin razón.

### MessagePack RPC

**Rechazado.** Wire format más eficiente que JSON, pero sin el ecosistema, codegen, ni streaming de gRPC.

### NATS request/reply (sin gRPC)

**Considerado.** NATS soporta request/reply síncrono. Perdió por:
- Sin codegen estricto del payload.
- Sin streaming bidireccional como primer-class citizen.
- Mezclar sync via NATS y async via NATS confunde el modelo mental — separamos los canales (gRPC para sync, NATS para async, ADR 0007).

Útil cuando solo hay un transport disponible. No es nuestro caso.

## Reglas operativas

1. **`vp-proto/` es source of truth.** Nadie escribe stubs a mano.
2. **`buf breaking` corre en CI.** PR que rompe compatibilidad es bloqueado a menos que se haga bump de versión major (`v1/` → `v2/`).
3. **mTLS obligatorio** en producción. Localhost dev usa `--insecure` solo en dev.
4. **Idempotency:** todo método mutador acepta `external_ref` en el request — `vp-engine` valida unique constraint en DB antes de ejecutar (ya está en `mlm.transaction.external_ref UNIQUE`).
5. **Timeouts:** cliente TS pone deadline de 5s por default en RPCs; calls largos (BonusRun) usan streaming o background job ID + polling.
6. **Errores:** códigos `connect.Code` mapeados a HTTP status en gateway; documentados en `vp-proto/README.md`.

## References

- `_meta/POLYGLOT_ARCHITECTURE.md` §3 — patrones de uso.
- ADR 0002 — polyglot TS + Go.
- ADR 0007 — NATS para async (complemento).
- Buf: https://buf.build/docs/
- Connect (Buf): https://connectrpc.com/
- Stack Overflow Performance comparison: https://grpc.io/blog/grpc-load-balancing/
- gRPC vs JSON benchmark: https://grpc.io/blog/optimizing-grpc-part-1/
