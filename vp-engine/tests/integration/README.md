# Integration tests

Tests con `testcontainers-go` que levantan Postgres + TimescaleDB + NATS reales.

```bash
make test-integration
```

## Convenciones

- Build tag `//go:build integration` en cada archivo — separa de tests unit.
- Cada test levanta sus propios containers (aislamiento) o usa `t.Helper()` + container compartido.
- Los datos del schema se cargan desde `_meta/schema_mlm.sql` + `schema_governance.sql` + `schema_payouts.sql`.
- Después de cada test, `truncate` o re-create de la DB.

## Suites planeadas

| Suite | Cobertura |
|---|---|
| `ledger_test.go` | PostTransaction idempotency, balance trigger, requires_pair enforcement |
| `binary_close_test.go` | CloseBinaryPeriod end-to-end con fixture de árbol |
| `binary_close_property_test.go` | Property tests (gopter): T1-T4 invariants holds para árboles aleatorios |
| `chainwatcher_test.go` | (fase 3) — mock TRC20 node, validar event emission |
| `concurrent_close_test.go` | Dos cierres concurrentes del mismo período → segundo aborta |
