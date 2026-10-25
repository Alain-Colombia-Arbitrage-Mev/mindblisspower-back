# Lecturas y cache del árbol — 2026-10-25

Se optimizaron dos rutas de lectura sin cambiar fórmulas de compensación ni decisiones de pago.

## Árbol administrativo

`GET /api/admin/tree/roots` y `GET /api/admin/tree/children` conservan por 15 segundos el modelo de presentación. La cache vive dentro de cada `Store`: no comparte datos entre bases de datos ni instancias del servicio. Las claves incluyen la raíz configurada o el padre consultado. Sus límites son 8 MiB serializados, 2.048 entradas y 64 cargas compartidas en vuelo. Las ramas vencidas se eliminan; al alcanzar los límites se expulsan las menos usadas. Cada consumidor recibe una copia independiente.

Las lecturas simultáneas de la misma clave se agrupan en una carga. `GET /api/admin/tree/full` solo agrupa lecturas simultáneas: no conserva el export completo de más de 121.000 nodos. Un fallo de consulta no se cachea. La carga compartida tiene un límite de 30 segundos y la cancelación de un navegador no cancela la respuesta de otros administradores.

Los handlers siguen comprobando autenticación, rol y estado de acceso en cada request antes de leer la cache. No se cachean permisos, elegibilidad de retiro ni datos usados para colocar usuarios o liquidar comisiones. Los límites HTTP y `Cache-Control: private, no-store` existentes siguen vigentes.

Se invalidan las ramas después del commit de activación, reubicación, edición de identidad, bloqueo/desbloqueo y eliminación lógica. También se invalidan al actualizar perfil/onboarding y al añadir o quitar entradas de blacklist. Una generación impide que una consulta iniciada antes de la invalidación vuelva a publicar un resultado viejo.

La invalidación es local a cada proceso. Cambios por SQL directo o desde otro proceso vencen con el TTL; si hay réplica de lectura, su retraso también forma parte de la frescura observada. Para futuras múltiples réplicas del servicio conviene publicar invalidaciones por eventos compartidos si el negocio exige coherencia inmediata del modelo visual. Las operaciones financieras y de estructura deben seguir leyendo el primario.

## Confirmación de Stripe

El modal y la página de confirmación consultan primero `/api/payments/me?fresh=1`. Consultan `/api/member/tree?view=position` solo después de confirmar un paquete activo. El polling usa `setTimeout` tras terminar cada intento: hay como máximo un intento pendiente por pantalla. Desmontar la pantalla cancela el request. Se respetan `Retry-After`, los límites de intentos y los límites totales de 60 y 36 segundos; una denegación 401/403 termina los reintentos.

No se conserva una respuesta financiera completada para reutilizarla. La lectura del resumen continúa siendo fresca y la posición se verifica con el endpoint del árbol.

## Evidencia reproducible

| Escenario | Antes | Después |
|---|---:|---:|
| 30 lecturas consecutivas de la misma rama, dentro del TTL | 30 queries | 1 query + 29 hits |
| 30 lecturas simultáneas de un mismo export | Hasta 30 cargas | 1 carga compartida |
| 20 intentos de confirmación mientras no existe paquete activo | 40 llamadas API | 20 llamadas API |
| 12 intentos en la página de confirmación sin paquete activo | 24 llamadas API | 12 llamadas API |
| Intentos solapados si una consulta tarda más de 3s | Posibles con `setInterval` | 1 intento en vuelo |

Los conteos de consultas de rama se comprobaron con un tracer de pgx y un PostgreSQL efímero de testcontainers. La misma prueba bloquea un miembro, confirma el commit y verifica una nueva query y el enmascaramiento inmediato de la identidad. No se usó la base depurada para esta prueba. Los demás conteos provienen de pruebas de concurrencia y lecturas con respuestas controladas; no constituyen una medición de tráfico de producción.

Comandos de validación:

```powershell
# backend/vp-engine
go test ./internal/payments -short -run '^TestTreeReadCache' -count=1
go test ./internal/payments -run '^TestAdminTreeReadCacheIntegration$' -count=1
go test ./internal/payments -run '^(TestListAdminTreeChildren_ReturnsMaskedUnavailableNodes|TestListAdminTreeRoots)' -count=1

# mindblisspowerfront
node --test src/lib/checkout-read.test.mjs src/lib/member-read.test.mjs
npx tsc -p jsconfig.json --noEmit
npx eslint src/app/dashboard/packages/PaymentResultModal.jsx src/app/dashboard/packages/confirmacion/page.jsx src/lib/checkout-read.mjs src/lib/checkout-read.test.mjs --quiet
```

La suite del cache también pasó con `go test -race` en una imagen Go local, con el código montado de solo lectura y sin red. Incluye expiración, invalidación durante una carga, aislamiento entre Stores/claves, copias independientes, límites de almacenamiento, cancelación, propagación de errores y comprobación de autorización vigente incluso con la rama ya cacheada.
