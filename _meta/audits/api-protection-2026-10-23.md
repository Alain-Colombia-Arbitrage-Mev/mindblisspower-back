# Proteccion API de vp-payments

Rama: `feature/api-protection-20261023`, sobre `5776c27`. Sin push ni despliegue.
No cambia SQL, schema, comisiones, pagos, reservas ni posiciones del arbol.
Los cambios previos de auditoria en blacklist/health/finance_test siguen
locales y no forman parte del commit de esta funcion. Las pruebas amplias
se ejecutan sobre ese workspace, no sobre una base restaurada a la fuerza.

## Politica de admision

| Clase | Limite por identidad, ruta y metodo |
| --- | ---: |
| API ordinaria, identidad verificada | 240/min |
| Busqueda administrativa de arbol | 60/min |
| Finanzas, solvencia, resumen, red/sostenibilidad, arbol completo, ventas | 30/min |
| Exportacion CSV | 2/min |
| POST de simulacion/reconciliacion/barrido administrativo | 2/min |
| Fallback por IP sin identidad, API ordinaria | 2.400/min |
| Baja de comunicados | 12.000/min; conserva controles por token en BFF |
| Techo compartido por ruta y metodo | 12.000/min |

El presupuesto Redis usa ventana fija de un minuto desde el primer acceso.
Las reglas se verifican e incrementan juntas por Lua, con expiracion atomica.
Una peticion rechazada no consume otra cuota. Se reparan contadores sin TTL.
Las claves nuevas tienen version y hash, no emails ni tokens de sesion.

Health, webhook Stripe y callbacks publicos de voz/WhatsApp conservan su
camino de firma/verificacion sin este limitador. No se agregan reintentos de
mutaciones. Pagos no compiten por los permisos de concurrencia de reportes.

## Concurrencia por proceso

- `PAYMENTS_MAX_CONCURRENT_READS`: 128 por defecto, rango 1..1024.
- `PAYMENTS_MAX_CONCURRENT_REPORTS`: 4 por defecto, rango 1..64.
- `PAYMENTS_MAX_CONCURRENT_WRITES`: 32 por defecto, rango 1..256.
- Valores invalidos usan el defecto, no desactivan la proteccion.
- Los GET/HEAD toman un permiso de lectura. Reportes y mantenimiento costoso
  comparten ademas el cupo de cuatro trabajos. No hay una cola HTTP ilimitada.
- Las mutaciones tienen su cupo separado de 32; Stripe no pasa por ese cupo.
  Una mutacion rechazada por admision no llega a ejecutar su handler.
- La clase costosa se mantiene aunque se cambie el verbo HTTP. Esto no
  habilita metodos que el handler no acepte.
- Al agotar cupo se responde 503 `server_busy`, espera 2s, sin ejecutar el
  handler. La cuota agotada devuelve 429 y la espera restante.
- Ambos incluyen Retry-After y retryAfterSec; las API privadas son no-store.
- Los permisos se liberan al salir del handler, tambien por error/panic.

No son limites de conexiones DB: el pool existente sigue configurado aparte.
No aumentarlo automaticamente ni multiplicar replicas sin presupuestar la
suma de conexiones de pagos, retiros, motor y frontends.

## Identidad y degradacion

Se prioriza identidad de JWT verificado, solo con token de servicio valido.
Renovar JWT, cambiar email del query o cambiar objetivo de impersonacion no
crea otro cupo para ese mismo actor. La verificacion puede reutilizarse solo
dentro de esa peticion; no se cachea autorizacion entre peticiones. Los
handlers mantienen validacion de identidad declarada, rol y suspension.

El modo legacy sin JWT conserva query-email unicamente para un BFF con token
de servicio valido y REQUIRE_VERIFIED_IDENTITY=false. No habilita un modo
nuevo de autenticacion. Para produccion, completar el rollout de identidad
verificada antes de exigirla. IP reenviada solo desde proxy privado/loopback;
se usa el ultimo hop. El proxy debe controlar esos headers y el servicio no
debe estar expuesto directamente a Internet.

Si falta Redis o falla, sigue activo un limitador local sincronizado con
maximo 50.000 contadores; al llenarse, rechaza nuevas claves sin desalojar
cuotas activas. Un fallo Redis abre pausa de conexion de 30s y hay plazo de
350ms para la operacion de presupuesto. Esto evita llamadas repetidas a un
Redis caido, sin permitir trafico ilimitado hacia Postgres.
Cancelar una peticion cliente no declara Redis caido ni abre ese circuito.

La degradacion es por proceso: no conserva una cuota global exacta durante
particiones, reinicios o transiciones Redis/local. La concurrencia tambien
se multiplica por replicas. En varias instancias, Redis saludable es parte
de la operacion; alertar ante su caida. Si no estuvo disponible al arranque,
el montaje actual de store/cache requiere reinicio para habilitarlo despues.

## Cache preexistente, sin ampliacion

| Recurso Redis | TTL existente |
| --- | ---: |
| Finanzas administrativas | 20s |
| Solvencia | 20s |
| Resumen del miembro | 15s, con camino fresh existente |
| Contexto de nombre/referido | 10min |
| Escenarios hipoteticos Monte Carlo | 1h; la parte live se calcula fresca |

No se cambian estos TTL ni sus invalidaciones de dominio. No se agrega cache
de posiciones, blacklist ni roles. El cache no sustituye validaciones antes
de ejecutar operaciones financieras.

## Verificacion y despliegue pendiente

- Pruebas de cuota/concurrencia: rafaga de 1.100 goroutines, aislamiento de
  1.100 identidades, TTL, memoria acotada, fallo Redis, rotacion de token/act-as,
  permisos liberados y pagos/webhooks fuera del cupo de reportes.
- Redis real temporal: dos clientes, 100 operaciones concurrentes, exactamente
  30 admisiones, contador compartido=30 y reparacion de expiracion ausente.
- `go test ./... -short` y `go vet ./...`: ejecutados. En Windows hay que usar
  DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine; el primer intento sin
  ese ajuste fallo al descubrir el proveedor Docker y se repitio correctamente.
- `go test -race` no disponible en este host por CGO deshabilitado. Ejecutarlo
  en CI Linux antes de fusionar. No se elimino ninguna prueba para aprobar.
- El Redis de QA es aislado en loopback y se retira al finalizar. No se uso
  ningun Redis, Postgres ni clave de produccion.

Estas pruebas no certifican 1.100 usuarios con consultas y pagos reales.
En staging medir p95/p99, 429/503 por ruta, cola/uso del pool SQL, memoria,
cache hit ratio y estado Redis. Ajustar los cupos con esas mediciones y
coordinar este backend con las ramas de ambos frontends antes de publicar.

Referencias: [INCR y atomicidad de expiracion](https://redis.io/docs/latest/commands/incr/),
[Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After).
