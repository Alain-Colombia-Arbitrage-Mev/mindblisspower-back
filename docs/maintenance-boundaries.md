# Límites de mantenimiento

Los módulos separan transporte, validación, autorización, dominio y persistencia.
La extracción conserva rutas públicas; no introduce servicios ni llamadas remotas nuevas.

La centralización completa del ledger sigue siendo trabajo posterior: Payments,
Withdrawals y BonusEngine aún contienen SQL financiero propio. Este cambio aplica
el mismo candado de recuperación en sus entradas, sin reescribir asientos ni fórmulas.

| Área | Responsabilidad |
| --- | --- |
| `app/src/server.ts` | Composición HTTP, sesión, límite de cuerpo y errores |
| `app/src/http/` | Validación y adaptadores de rutas; sin SQL financiero directo |
| `app/src/server/admin-gate.ts` | Autorización administrativa vigente |
| `app/src/modules/ledger/` | Comandos contables y dependencias explícitas |
| `vp-engine/internal/ledger/` | Ledger atómico, idempotencia y pares contables |
| `vp-engine/internal/payments/` | Identidad, checkout, webhooks y lecturas de miembros/admin |

## Invariantes de API

- Las lecturas no escriben ni evalúan alertas con efectos secundarios.
- IDs `bigint` viajan como cadenas o enteros JS seguros. Dinero no pasa por floats.
- Los movimientos deben caber en `numeric(20,8)`; se rechaza el redondeo implícito.
- El autor contable se resuelve desde la sesión, no desde un ID enviado por el cliente.
- Los cuerpos inválidos devuelven 400; cuerpos excesivos, 413. Los errores internos
  no exponen credenciales, SQL ni contenido del usuario.
- Una recuperación Stripe no constituye un ledger operativo. Los comandos financieros
  se rechazan mientras ese modelo exista; no basta ocultar botones en el navegador.
- Los importes no calculados se representan con `null`, nunca con un cero inventado.
  Los fondos recibidos por la empresa no se atribuyen como pagos a afiliados.

Ver [contrato de recuperación y reanudación](recovery-read-model.md).

## Caché

El árbol administrativo usa una caché acotada por Store y claves de rama, TTL corto,
coalescencia de lecturas e invalidación después de commits. Es exclusivamente visual:
la autorización se comprueba en cada petición y el dominio lee la base primaria.
No se guarda el export completo como una respuesta financiera reutilizable.
Ver [pruebas y límites del caché](query-cache-optimization-20261025.md).

## Verificación antes de publicar

```sh
# Desde app: sin cargar archivos .env de producción
bun test
bun run typecheck
bun scripts/pentest-http.ts

# Desde vp-engine; requiere Docker para integración
go test ./... -run '^$'
go vet ./...
go test ./internal/payments -count=1 -timeout=15m

# Desde backend: políticas y archivos seleccionados para Git
node --test scripts/security/check-staged.test.mjs deploy/portable/manage.test.mjs deploy/portable/release-policy.test.mjs
node scripts/security/check-staged.mjs .
```

Los tests de persistencia deben usar bases efímeras, nunca la copia curada ni un
`DATABASE_URL` de producción. Las pruebas HTTP sintéticas no contactan Stripe real.
Los respaldos, claves, exportaciones y runbooks del incidente permanecen privados.

Los PRs no habilitan despliegues ni compensaciones. Publicar una rama, publicar una
imagen y activar un despliegue son pasos distintos con sus propios controles.
