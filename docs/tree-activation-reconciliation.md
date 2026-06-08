# Arbol binario: activacion, codigos y reconciliacion

Este documento separa tres responsabilidades que no deben mezclarse:

- Activar usuarios nuevos y colocarlos en el arbol.
- Resolver codigos de referido / afiliado.
- Reconciliar raices heredadas de migracion.

La regla operativa es estricta: una activacion nueva nunca repara raices
migradas, y una reconciliacion de raices nunca crea usuarios nuevos ni activa
Cognito/auth.

## Estado actual

La escritura productiva del arbol vive hoy en la API TypeScript:

- `app/src/auth.ts`: crea `mlm.person` despues del signup.
- `app/src/server/affiliate.ts`: coloca afiliados y emite `mlm.tree_event`.
- `app/src/server.ts`: expone los endpoints actuales.

El servicio Go `vp-engine` ya cubre simulacion, cierre binario, ledger y asesor
IA, pero `internal/treewriter` sigue pendiente. Cuando se implemente, debe
absorber las mutaciones criticas de arbol y dejar a `app` como capa HTTP/auth.

## Flujo A: activacion nueva

Objetivo: convertir una identidad autenticada en una persona activa y una
posicion unica dentro del arbol.

Pasos esperados:

1. Validar sesion/auth y email verificado.
2. Crear o actualizar `mlm.person` con datos personales y estado operativo.
3. Resolver el sponsor desde codigo de referido o seleccion administrativa.
4. Ejecutar colocacion manual o weak-leg bajo el sponsor.
5. Insertar `mlm.affiliate`.
6. Insertar `mlm.tree_event` tipo `enrollment`.
7. Auditar la accion.

Restricciones:

- No toca `wallet_movement`.
- No acredita volumen ni PV historico.
- No repara `parent_id IS NULL` heredados.
- No mueve afiliados existentes.
- Debe ser idempotente por una llave externa estable, por ejemplo
  `activation:<auth_user_id>` o `enrollment:<person_id>`.

## Flujo B: codigos de afiliado

El codigo de afiliado identifica al sponsor comercial; no decide por si solo el
slot binario final.

Contrato recomendado:

1. `code -> sponsor_affiliate_id`.
2. `sponsor_affiliate_id + preferredSide? -> autoPlaceAffiliate`.
3. La regla weak-leg decide el `parent_id` final cuando el sponsor ya tiene
   piernas ocupadas.

La tabla `mlm.affiliate` ya tiene `invitation_link text UNIQUE`, pero falta un
contrato backend formal para generar y resolver codigos. Recomendacion:

- Usar un codigo publico estable y no sensible, por ejemplo `MBP-<base32>`.
- No usar email, nombre, telefono ni identificadores PII.
- Mantener unicidad en DB.
- Registrar rotacion de codigo en auditoria si se permite regenerarlo.
- Resolver codigos con un endpoint dedicado, sin exponer datos privados del
  sponsor.

Endpoints sugeridos:

- `GET /api/referrals/me`: devuelve codigo y link del afiliado autenticado.
- `POST /api/referrals/resolve`: recibe codigo y devuelve sponsor publico.
- `POST /api/admin/referrals/:affiliateId/regenerate`: rota codigo con auditoria.

## Flujo C: reconciliacion de raices migradas

Objetivo: tomar afiliados o subarboles heredados que quedaron como raices y
conectarlos a una raiz canonica sin romper invariantes.

Esto debe ejecutarse como job administrativo separado, con dry-run obligatorio.
No pertenece a login, registro, onboarding ni activacion.

Pasos del job:

1. Congelar una foto de las raices candidatas.
2. Clasificar cada raiz: canonica, huerfana, sponsor conocido, parent legacy
   conocido, o dato insuficiente.
3. Proponer `new_parent_id` y `new_position` con una regla deterministica.
4. Guardar el plan en una tabla de staging/runbook.
5. Ejecutar dry-run y validar:
   - sin duplicados `(parent_id, position)`;
   - sin ciclos;
   - path valido para todo el subarbol;
   - conteos recomputables;
   - PV y wallets permanecen en cero si el cutover es arranque en cero.
6. En commit, mover subarboles bajo lock global de reconciliacion.
7. Recalcular `path`, `depth`, `left_count`, `right_count` por subarbol.
8. Emitir `tree_event` tipo `position_move` con payload de auditoria.
9. Correr validaciones finales y dejar reporte firmado.

Restricciones:

- No crea `auth.user`.
- No crea `mlm.person`.
- No activa Cognito.
- No inserta `pv_credit`.
- No inserta `wallet_movement`.
- No se dispara desde endpoints publicos.

## Go: modulo pendiente `treewriter`

La implementacion Go debe seguir capas simples:

```text
internal/treewriter/
  handler.go      # gRPC/admin command handlers, sin SQL directo
  service.go      # reglas de negocio e idempotencia
  repository.go   # pgx/sqlc, transacciones y locks
  types.go        # DTOs internos
```

Operaciones recomendadas:

- `ActivateAffiliate(ctx, input)`: activacion nueva, sin reconciliacion.
- `AutoPlaceAffiliate(ctx, input)`: weak-leg transaccional.
- `ResolveReferralCode(ctx, code)`: sponsor desde codigo publico.
- `GenerateReferralCode(ctx, affiliateID)`: codigo estable y unico.
- `PlanRootReconciliation(ctx, input)`: dry-run, no muta arbol.
- `CommitRootReconciliation(ctx, runID)`: mutacion admin auditada.
- `RecomputeTreeAggregates(ctx, rootID)`: reconstruye conteos/PV desde verdad.

Locks recomendados:

- Activacion/auto-place: advisory lock por sponsor.
- Colocacion manual: `FOR UPDATE` sobre parent.
- Reconciliacion: advisory lock global de mantenimiento y `FOR UPDATE` sobre
  subarboles afectados.

## Asesor IA

`vp-engine/internal/networkintel` ya implementa:

- Analisis deterministico local como fuente de verdad.
- OpenRouter opcional para lectura estrategica.
- Modelo primario por defecto: `xiaomi/mimo-v2.5-pro`.
- Fallback por defecto: `minimax/minimax-m3`.
- Endpoints HTTP: `/network/analyze` y `/api/network/analyze`.

Regla de seguridad: el LLM no decide mutaciones. Solo interpreta metricas,
riesgo, pierna debil y acciones sugeridas. Las decisiones que cambian arbol,
pagos o ledger deben pasar por reglas deterministicas y auditoria.

