# Backend

Esta carpeta agrupa los servicios y contratos ejecutables del backend.

- `app/`: API TypeScript/Bun/Hono. Orquesta HTTP, auth, modulos de negocio y cliente gRPC hacia el motor.
- `vp-engine/`: servicio Go para el camino caliente: ledger, payouts, cierre binario, jobs y simulador.
- `_meta/`: fuente de verdad de schemas, migraciones, ADRs, specs matematicas y devops.
- `legacy/`: backup y artefactos de referencia de SQL Server.

La regla practica es simple: si calcula dinero, escribe ledger o cierra bonos, vive en
`vp-engine`; si autentica, autoriza o expone HTTP publico, vive en `app`.

## Regla de arbol

Las activaciones nuevas y la reconciliacion de raices migradas son flujos
separados:

- Una activacion nueva crea/actualiza identidad, coloca un afiliado y emite un
  `tree_event` de `enrollment`.
- Una reconciliacion de raices es un job administrativo con dry-run; mueve
  subarboles heredados, recalcula paths/conteos y audita `position_move`.

No mezclar estos flujos en login, registro, onboarding ni endpoints publicos.
Ver `docs/tree-activation-reconciliation.md`.

## Mantenimiento y verificación

Ver [límites de módulos y contratos de seguridad](docs/maintenance-boundaries.md)
y [responsabilidades de Payments](vp-engine/internal/payments/README.md).
Las lecturas de recuperación son evidencia, no activaciones ni comisiones calculadas.

La integración [Better Auth, mensajería e identidad](docs/auth-identity-cutover.md)
es opt-in y requiere migración y corte coordinados antes de activarse.
El [contrato de códigos por email](docs/email-auth-backend.md) usa la librería
gratuita dentro de la API existente y Cloudflare para entregar los correos;
no requiere otro servicio de autenticación de pago.
