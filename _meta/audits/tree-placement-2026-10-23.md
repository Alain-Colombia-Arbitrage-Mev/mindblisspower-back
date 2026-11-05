# Revision de posiciones y colocacion binaria

Fecha: 2026-10-23. Rama: `feature/tree-placement-20261023`.
Alcance: backend Go de pagos, consultas administrativas del arbol y proteccion
de las rutas manuales de la API Bun. Sin despliegue ni cambios de posiciones
en datos reales. Los cambios previos de health/blacklist/finance quedan separados.

## Fuente de verdad y reglas actuales

- `mlm.affiliate.parent_id` + `position` (`L`/`R`) definen la posicion fisica.
  `sponsor_id` identifica al patrocinador comercial; no sustituye al padre.
- Registrar una persona no la coloca. El webhook de pago confirmado activa la
  compra y crea el afiliado si aun no existe, dentro de la misma transaccion.
- El enlace con lado explicito sigue L -> L o R -> R hasta el primer espacio
  libre. No es una busqueda por niveles ni alterna los lados.
- Sin lado explicito, cada paso elige menor PV actual; empata por menor conteo
  y despues L. Se mantiene esta politica; no se recalculan posiciones antiguas.
- Si el comprador ya tiene afiliado, nuevas compras conservan su posicion.
- Un baneo conserva padre, lado, ruta y descendientes. El explorador muestra el
  nodo como `Not Available` y permite seguir navegando por sus hijos.
- El trigger de insercion calcula `path`/`depth` y mantiene `affiliate_closure`.
  Un indice unico impide dos hijos en un mismo espacio padre/lado.

## Problemas reproducidos y correcciones

1. Dos sesiones de compra del mismo comprador podian resolver "sin afiliado"
   antes del lock por patrocinador. La segunda fallaba con SQLSTATE 23505 y su
   activacion se revertia. Ahora se bloquea la persona con `FOR NO KEY UPDATE`
   antes de consultar su afiliado. Otros compradores no comparten este lock.
2. La validacion del comprador usaba el email historico del checkout. Si habia
   cambiado de correo, podia ignorar un baneo posterior. Se usa el email actual
   de la persona bloqueada por ID, conservando el cargo para revision.
3. Un patrocinador vetado solo por `mlm.blacklist` seguia siendo elegible si su
   persona/afiliado figuraban activos. El mismo predicado SQL valida codigo,
   registro persistido y activacion, incluyendo email, telefono y nombre/fecha.
   Un pago ya recibido bajo un patrocinador no elegible queda `needs_placement`.
4. Las raices bloqueadas desaparecian del endpoint roots. Ahora se enmascaran
   igual que los hijos sin retirar su nodo estructural.
5. La busqueda administrativa marcaba rutas ciclicas o cortadas como revelables.
   Ahora evita IDs repetidos y solo permite revelar rutas que llegan a una raiz.
6. `mlm.norm_name` fallaba en conexiones cuyo search_path no incluia el esquema
   donde se instalo unaccent. Migracion 68 resuelve el esquema de la extension
   y califica la funcion. No modifica datos, indices ni normalizaciones previas.
7. Las rutas Bun `/api/affiliate/place` y `/api/affiliate/auto-place` permitian
   colocar otras personas con una sesion comun. Ahora exigen el middleware
   existente de administrador activo. Ninguno de los dos frontends consume esas
   rutas; el flujo Stripe normal sigue siendo Go.

El lock de fila permite serializar por comprador sin bloquear referencias FK
normales; ver [PostgreSQL: row-level locks](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).
La funcion unaccent usa el diccionario de su propio esquema cuando no se pasa
uno; ver [PostgreSQL: unaccent](https://www.postgresql.org/docs/17/unaccent.html).

## Contraste con los frontends

Se revisaron `mindblisspowerfront/src/app/api/member/tree/route.js`,
`src/app/dashboard/network/page.jsx`,
`src/components/panel/network/BinaryTreeView.jsx` y
`mindblisspower-admin/src/components/sections/AdminTreeExplorer.jsx`.
El flujo usado por ambos enlaza por padre y lado, no por patrocinador. El cliente
consulta su subarbol y el admin navega por raices/hijos. Profundidad o truncado
pueden mostrar distinta cantidad de nodos, pero no justifican mover posiciones.
No se cambiaron UI, importes, PV ni formulas de comisiones en esta revision.

## Auditoria real de la copia historica local

Contenedor: `mindbliss-local-recovery-20261022`, DB `vicionpower`.
Servidor con `default_transaction_read_only=on`, sin puertos publicados.
Ejecutado `20261023_tree_placement_audit.sql` en una transaccion de solo lectura
con snapshot repetible y timeout de 45 segundos. Solo se exportaron agregados.

| Comprobacion | Resultado |
| --- | ---: |
| Afiliados | 121013 |
| Raices del bosque | 21016 |
| Profundidad maxima guardada | 364 |
| Espacios padre/lado duplicados | 0 |
| Padres inexistentes | 0 |
| Diferencias de ruta/profundidad respecto al padre | 0 |
| Filas self/parent faltantes en closure | 0 / 0 |
| Alcanzables desde las raices | 121013 |
| No alcanzables / guardia de 1024 niveles alcanzada | 0 / 0 |
| Diferencias de profundidad calculada desde raiz | 0 |
| Sponsor fuera de la ascendencia binaria | 26040 |
| Purchase intents Stripe en esta copia | 0 |

Los 26040 casos de patrocinador se desglosan en 21015 raices y 5025 nodos
colocados. Todos tienen ID legacy. Son una discrepancia comercial/estructural
para revisar, no evidencia suficiente para cambiar el padre. La proteccion de
checkout existente puede bloquear recompras si sponsor y ascendencia no estan
alineados. Se requiere validar la atribucion historica por lotes con negocio.
No se deben fusionar las 21016 raices ni recolocar esos usuarios automaticamente.

Esta copia NO permite validar usuarios nuevos, pagos Stripe ni volumenes actuales
de produccion. El audit comprueba enlaces locales, profundidad, alcance y closure
inmediata; no recalcula toda la closure transitiva ni concilia PV historico.

## Pruebas

- Regresion inicial confirmada: duplicado `affiliate_person_id_key`, patrocinador
  blacklist elegible y raiz bloqueada ausente; ademas fallo de unaccent en
  conexiones nuevas. Todas corregidas en PostgreSQL aislado de Docker.
- `TestPlacementSafety_Integration`: normalizacion con search_path pg_catalog,
  dos pagos simultaneos de una persona, email viejo y baneo, blacklist-only,
  cadena explicita L/R, pierna debil, 12 compradores concurrentes con sponsors
  solapados, raiz bloqueada, derrame bajo bloqueados y ruta ciclica.
- Bateria dirigida de activacion, referidos, derrame, checkout, roots/full y
  reubicacion: aprobada. La reubicacion solo se ejercita en fixtures desechables.
- `go test ./internal/payments -short -count=1 -timeout=8m`: aprobado en 291.337s.
  Algunas integraciones omiten -short; se cubrieron tambien con ejecuciones
  dirigidas sin esa opcion.
- Los 10 casos nuevos y la busqueda administrativa se repitieron tres veces
  sin -short: aprobados en 43.604s. Incluye reaplicar migracion 68 para verificar
  que un despliegue repetido no falla.
- `go vet ./...`: aprobado.
- Bun: prueba AST de que ambas rutas manuales conservan `requireAdmin`, prueba
  del predicado de admin activo y `tsc --noEmit` aprobados.
  `bun test src/server/admin-gate.test.ts src/server/placement-routes.test.ts`:
  2 pruebas aprobadas, 9 aserciones.
- No se ejecutaron pagos reales, OTP, carga de 1100 usuarios ni detector de races
  Linux. La prueba concurrente de DB no sustituye esa prueba de capacidad.

## Preparacion para despliegue

1. Respaldar y validar la DB real; ejecutar el audit de solo lectura alli.
2. Aplicar `_meta/migration/68_blacklist_normalization_schema.sql` con el owner
   de `mlm.norm_name`, despues de las migraciones previas. Es reejecutable y no
   depende de que unaccent este en mlm o public. No requiere mover la extension.
3. Desplegar los servicios Go/Bun de esta rama y validar una compra controlada,
   el mismo afiliado en cliente/admin y los casos `needs_placement`.
4. Vigilar errores de activacion, espera de locks y colas antes de ampliar carga.

Limites existentes conservados: descenso Go hasta 512 pasos con 16 reintentos de
colision; cache/limites de API de la rama anterior; elegibilidad de rangos y PV.
La API manual Bun sigue siendo una herramienta administrativa separada con
algoritmo legacy: no debe reemplazar el flujo canonico Go de compra.
No se hizo push ni despliegue y no se aplico migracion 68 a la copia historica.
