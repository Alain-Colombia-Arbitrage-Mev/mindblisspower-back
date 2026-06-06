# Backend

Esta carpeta agrupa los servicios y contratos ejecutables del backend.

- `app/`: API TypeScript/Bun/Hono. Orquesta HTTP, auth, modulos de negocio y cliente gRPC hacia el motor.
- `vp-engine/`: servicio Go para el camino caliente: ledger, payouts, cierre binario, jobs y simulador.
- `_meta/`: fuente de verdad de schemas, migraciones, ADRs, specs matematicas y devops.
- `legacy/`: backup y artefactos de referencia de SQL Server.

La regla practica es simple: si calcula dinero, escribe ledger o cierra bonos, vive en
`vp-engine`; si autentica, autoriza o expone HTTP publico, vive en `app`.
