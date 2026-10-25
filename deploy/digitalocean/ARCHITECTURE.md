# Arquitectura objetivo: Mindbliss en DigitalOcean App Platform

Propuesta sustituida el 2026-10-24: el destino elegido por el usuario es
[Cloudflare + PlanetScale](../cloudflare/README.md). Se conserva este documento
como referencia historica; no autoriza provisionar o desplegar DigitalOcean.

Fecha: 2026-10-24. Estado: propuesta tecnica definida, NO provisionada.
Este documento no afirma que las plantillas actuales ya implementen todo el
diseno ni que las pruebas Docker certifiquen el runtime administrado.

## Decision

App Platform para aplicaciones sin estado; PostgreSQL 17 administrado como
fuente de verdad; Valkey administrado para cache/limites; Spaces privado para
archivos; copias cifradas adicionales en otro proveedor y otra cuenta.
Mantener los repositorios y servicios existentes, sin Kubernetes, Kafka, NATS,
Supabase ni una reescritura de autenticacion durante este cambio de hosting.

Objetivo de dimensionamiento: 1.100 sesiones concurrentes interactivas, NO
1.100 transacciones financieras por segundo. El rendimiento debe medirse antes
del lanzamiento; los tamanos siguientes son un punto de partida, no capacidad
certificada. La cantidad de usuarios registrados no determina por si sola CPU.

## Entornos y red

| Recurso | Produccion | Staging |
| --- | --- | --- |
| Proyecto organizativo | mindbliss-prod | mindbliss |
| App completa | mindbliss-production | mindbliss-staging |
| Region App Platform | nyc | nyc |
| VPC | prod en nyc1 | staging en nyc1 |
| PostgreSQL | Cluster propio HA | Cluster propio sin HA |
| Valkey | Cluster propio HA | Cluster propio pequeno |
| Credenciales y archivos | Solo productivos | Solo prueba o anonimizados |
| Stripe | Live tras aprobar el corte | Test |

El usuario confirmo la creacion de los proyectos `mindbliss` y `mindbliss-prod`.
Esta asignacion usa `mindbliss` para staging; no se verificaron IDs ni recursos
mediante la API cloud. Los nombres de apps de la tabla siguen siendo propuestos
y no deben confundirse con los nombres de proyectos ya creados.

Los proyectos organizan recursos, NO sustituyen permisos/aislamiento. Restringir
IAM por rol, MFA, credenciales separadas y aprobacion de produccion. No abrir
peering entre VPC de staging y produccion. El build puede usar un registro
compartido de solo lectura para runtime, sin secretos dentro de las imagenes.

App Platform `nyc` se conecta directamente a VPC en `nyc1`. Crear DB y cache ahi
para evitar latencia y peering innecesarios. Habilitar VPC en cada app y permitir
en trusted sources solo su IP privada de salida y operaciones autorizadas.
No abrir DB/cache a `0.0.0.0/0`. VPC y dedicated egress IP no se pueden combinar
en la misma app: revisar antes si BMP exige una IP publica de salida fija.
Fuente: [VPC de App Platform](https://docs.digitalocean.com/products/app-platform/how-to/enable-vpc/).

## Trafico y componentes

```text
Navegador --HTTPS--> Edge de App Platform
                       |-- cliente Next.js + BFF
                       |-- admin Next.js + BFF
                       |-- API Bun / autenticacion, solo rutas necesarias
Stripe --HTTPS firmado-+-- payments: SOLO /api/webhooks/stripe

Cliente/admin/Bun --red interna--> engine / payments / withdrawals
API Bun ----------gRPC mTLS------> engine
Servicios --------VPC + TLS------> PostgreSQL 17 / Valkey
Servicios --------HTTPS----------> Spaces privado / proveedores externos
Job backup -------TLS + age------> almacenamiento de otra cuenta/proveedor
```

Es un esquema de conectividad, no una cadena obligatoria de todas las lecturas.
Los BFF existentes tambien acceden a PostgreSQL directamente para lecturas de
miembros: conservar inicialmente ese camino con rol solo lectura y pool acotado.
No permitir escrituras financieras desde el navegador ni desde ese rol.

Cliente, admin y backend deben ser componentes de la MISMA app por entorno;
no son seis apps independientes. Asi los BFF alcanzan los servicios por nombre
interno sin publicar endpoints de administracion.
Fuente: [enrutamiento interno](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/).

### Dimensionamiento inicial de produccion

| Componente | Instancias | Recurso por instancia | Acceso |
| --- | --- | --- | --- |
| Cliente Next.js/BFF | 2 | 1 vCPU dedicada, 2 GiB | Publico HTTPS |
| Admin Next.js/BFF | 1 | 1 vCPU compartida, 1 GiB | HTTPS, autenticacion y control de acceso |
| API Bun | 2 | 1 vCPU compartida, 1 GiB | Solo rutas publicas necesarias |
| Engine Go | 2, tras validar concurrencia | 1 vCPU compartida, 1 GiB | Privado HTTP/gRPC mTLS |
| Payments Go | 2, tras validar concurrencia | 1 vCPU compartida, 1 GiB | Privado; webhook exacto publico |
| Withdrawals Go | 2, tras validar concurrencia | 1 vCPU compartida, 1 GiB | Privado |
| Jobs | Ejecucion puntual exclusiva | Segun tarea | Sin ingress |

CPU compartida reduce coste en servicios principalmente limitados por DB/IO.
Si la carga demuestra CPU sostenida o p95 inestable, promover ese componente a
CPU dedicada antes de aumentar replicas indiscriminadamente. El admin con una
instancia NO tiene redundancia de aplicacion; pasar a dos si se exige su misma
disponibilidad que la tienda. No activar Scale to Zero en produccion.

Jobs financieros apagados en todas las replicas HTTP. Antes de habilitarlos,
crear un ejecutor exclusivo con bloqueo distribuido, idempotencia y recuperacion
de tareas interrumpidas. Una sola instancia configurada no evita solapamientos
durante despliegues. No usar Valkey como registro definitivo de pagos o bonos.

Escalar primero cliente por RPS/p95, entre 2 y 4 instancias tras medir umbrales.
Mantener servicios privados con replicas acotadas y ajustar por CPU/latencia DB.
Autoscaling HTTP solo aplica a servicios que reciben trafico externo; CPU-based
requiere CPU dedicada. No exponer un servicio solo para obtener esa metrica.
Fuente: [escalado](https://docs.digitalocean.com/products/app-platform/how-to/scale-app/).

Staging conserva los seis componentes con una instancia de 1 GiB cada uno;
DB independiente de 2 GiB y cache de 1 GiB. No es una replica de rendimiento de
produccion. Para carga, crear temporalmente un staging con el mismo tamano y
topologia que produccion y datos sinteticos representativos.

## PostgreSQL y consistencia financiera

- PostgreSQL 17 Advanced Edition para produccion, primario y standby, minimo
  propuesto de 2 vCPU/8 GiB por nodo. Confirmar configuracion HA y precio exactos
  ofrecidos en la cuenta antes de contratar. No depender de una oferta Standard
  HA que ya no este disponible para una cuenta nueva.
- Solicitar explicitamente version 17; Advanced soporta 17 pero nuevas bases
  usan 18 por defecto. `ltree`, `btree_gist`, `citext` y `pgcrypto` figuran como
  disponibles; validar versiones, funciones, propietarios y grants restaurando
  una copia en el cluster real antes de aprobar compatibilidad.
- Sin Timescale en el destino. Una base Timescale existente requiere conversion
  controlada/restauracion en un destino nuevo, no cambiar la imagen de PGDATA.
- Empezar sin read replicas: bosque, saldos y autorizaciones leen del primario
  para evitar retrasos de replicacion. Un standby no es un endpoint de lectura.
- Usar endpoint/pooler administrado y TLS verificado. Advanced usa confianza
  del sistema, no asumir la CA descargable de Standard; revisar cada driver,
  backup y plantilla. No inyectar una CA sintetica en la nube.
- Roles por servicio; rol member solo lectura, migrador separado y sin
  superuser para aplicaciones. No usar un unico DATABASE_URL global con el
  mismo escritor para todos los componentes.
- Presupuesto inicial propuesto: maximos 10 por replica Bun/Go y 4 por BFF,
  mas una reserva operativa para backups/migraciones. Con 8 replicas Bun/Go y
  3 BFF, el techo base seria 92 conexiones de aplicaciones; reservar capacidad
  para rolling deployments y escalado. Comprobar el limite REAL del plan/pooler.
  1.100 sesiones web NO deben crear 1.100 conexiones PostgreSQL.
- Evaluar transaction pooling por servicio. Desactivar prepared statements en
  drivers que lo requieran y probar locks/session state; usar conexion directa
  o session-compatible para refresh con advisory locks y mantenimiento.
- Un evento Stripe se registra idempotentemente en DB. Reintentos de webhooks y
  reconexion tras failover no deben generar doble compra, posicion ni comision.
  Venta/ledger/arbol conservan sus contratos e invariantes. Los reportes de
  Ventas, Finanzas y Centro de mando consumen la misma base de calculo.

Fuentes: [Advanced Edition](https://docs.digitalocean.com/products/databases/postgresql/concepts/advanced-edition/),
[extensiones](https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/#advanced-edition-supported-extensions),
[cambio de planes](https://docs.digitalocean.com/release-notes/upcoming/dbaas-plan-changes/).

## Cache, limites y autenticacion

Valkey compatible con Redis, privado y con TLS; en produccion, primario/standby.
Cache-aside con TTL e invalidacion tras escrituras; claves por usuario/rol y
entorno. Nunca cachear OTP, contrasenas, autorizaciones ni resultados personales
en CDN. Catalogo publico puede usar cache mas larga; arbol/resumen, cache corta
segun tolerancia acordada. Retiros y validacion de fondos consultan la verdad
transaccional, no un saldo cacheado. Si cache falla, lecturas degradan con
concurrencia limitada; no permitir una estampida ilimitada hacia PostgreSQL.

Antes de activar multiples replicas, mover presupuestos OTP/auth/API a un
limitador atomico compartido. Separar cache evictable de presupuestos de
seguridad; si comparten cluster, usar noeviction, capacidad y politicas de fallo
revisadas. Un cache miss NO puede significar reiniciar un limite OTP. Si falla
el limitador compartido, OTP/operaciones sensibles fallan cerradas o tienen un
fallback estricto previamente probado, nunca envios ilimitados.

Conservar las identidades y proveedor actual durante el primer corte para no
mezclar migracion de hosting y auth. Cognito/SES/BMP son dependencias externas:
confirmar que estan operativas y revisar OTP/entrega, JWKS, expiracion y MFA.
Si la suspension AWS sigue afectando auth/correo, BLOQUEA el lanzamiento hasta
restaurar ese servicio o aprobar una migracion separada. El mock local NO es
un proveedor de autenticacion productivo. No se ha eliminado la dependencia AWS.

## Seguridad y archivos

Publicar solo cliente/admin, rutas necesarias de Bun y webhook exacto firmado.
No publicar `/api/admin/*` de Go, engine o withdrawals. Verificar JWT, token
interno y autorizacion en servidor; proteger admin con MFA/SSO y, si se coloca
un gateway de acceso delante, evitar bypass por dominio alternativo del origen.
TLS, HSTS, cookies seguras, CSRF/origin, CORS limitado y secretos de runtime.
Revisar confianza en cabeceras IP del edge antes de aplicar limites por IP.

Espacios privados separados para staging/production y KYC; URLs firmadas de
corta vida, control de acceso servidor, sin CDN publica para documentos privados.
No guardar uploads ni DB en el filesystem efimero de App Platform. Habilitar
registro de accesos y retencion segun requisitos legales, sin registrar OTP,
tokens, PAN/CVC ni documentos de identidad en logs.

Limite de cumplimiento: App Platform NO declara PCI DSS compliant. Stripe
Checkout alojado evita que la app capture tarjetas, pero no certifica ni elimina
automaticamente el alcance PCI de la operacion. Responsable de cumplimiento
debe aprobar el diseno antes de mover trafico financiero real.
Fuente: [limites oficiales](https://docs.digitalocean.com/products/app-platform/details/limits/).

## Recuperacion y observabilidad

- HA cubre fallos de nodo, no borrados logicos ni un desastre regional completo.
- PITR administrado hasta los ultimos 7 dias segun documentacion actual.
- Dump logico completo cifrado con age cada 6 h hacia otro proveedor/cuenta;
  conservar manifiesto/hash, roles revisados y claves privadas offline. La copia
  externa cada 6 h tiene un RPO peor o igual a 6 h mas demora, NO de minutos.
- Propuesta de retencion externa: 7 dias de copias cada 6 h, diarias 30 dias y
  mensuales 12 meses; revisar privacidad, coste y obligaciones de borrado.
- Restaurar mensualmente en destino nuevo, comprobar ultima transaccion,
  ledger/Stripe/arbol/posiciones, contar datos y medir RTO/RPO. No declarar
  objetivos conseguidos antes del ensayo. No restaurar sobre la DB activa.
- Si se exige RPO de minutos incluso perdiendo la cuenta/proveedor completo,
  hace falta otra solucion de replicacion/WAL independiente validada; PITR en
  la misma cuenta mas pg_dump no lo garantiza.
- Logs estructurados y alertas fuera del proceso: errores/p95, DB conexiones,
  disco, bloqueos, latencia, errores Stripe, OTP, expiracion TLS y ultimo backup.
  Enviar alertas a un canal que no dependa de la app caida.

Fuente: [backups y failover PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/details/features/).

## CI/CD y portabilidad

```text
PR -> tests/security + Docker sintetico -> review -> merge
   -> build Docker amd64 una vez -> registro privado por digest
   -> staging -> smoke/contratos/auth/pagos test -> aprobacion manual
   -> mismo digest a produccion -> verificaciones -> rollback si falla
```

Terraform para proyectos/VPC/recursos/accesos y App Spec versionado para cada
entorno. Guardar estado remoto cifrado y bloqueado, con backup y acceso separado;
el estado puede contener datos sensibles. Nada de apply automatico desde una PR.
La implementacion actual NO incluye Terraform DigitalOcean; si incluye CD
image-only manual, cerrado por defecto hasta completar [LAUNCH.md](LAUNCH.md).

DOCR es el registro de los publicadores preparados para los tres repositorios.
Falta configurar el registro y las credenciales, y ejecutar el flujo. El
publicador verifica que el digest remoto corresponde al candidato local probado.
Versionar un manifiesto de release con
los SHA de backend/cliente/admin. Una version puede combinar servicios de los
tres repos; no reconstruir frontend con secretos ni endpoints del entorno.

Migraciones revisadas tipo expand/contract, explicitamente ejecutadas con rol
limitado y lock. Rollback de imagen no revierte datos ni recupera transacciones.
Conservar Compose/runbook y dumps abiertos para poder salir de DigitalOcean;
no es necesario Dockerizar la DB productiva administrada para ser portable.

## Coste de referencia, no cotizacion

Precios consultados el 2026-10-24, USD/mes de funcionamiento continuo:

| Concepto | Calculo orientativo |
| --- | --- |
| Cliente dedicado, 2 x 2 GiB | 2 x 39 = 78 |
| Admin compartido, 1 x 1 GiB | 12 |
| Bun + 3 Go, 2 replicas de 1 GiB cada uno | 8 x 12 = 96 |
| Subtotal App Platform produccion | 186 |
| PostgreSQL Advanced HA | Desde aproximadamente 2 x 130 = 260; confirmar topologia y almacenamiento |
| Valkey HA, 2 x 2 GiB | Desde 60 |
| Spaces Standard | Desde 5 |
| Base produccion | Aproximadamente 511, antes de extras |
| Staging 6 servicios compartidos, PG 2 GiB, Valkey 1 GiB | Aproximadamente 72 + 30.45 + 15 = 117.45 |

Reservar aproximadamente 650-750 USD/mes incluyendo margen operativo para este
diseno de ambos entornos. Es una estimacion propia: registro, almacenamiento DB,
backup externo, jobs, trafico extra, logs, auth/correo, impuestos y escalado pueden
incrementarla. NO prometer la arquitectura HA completa por 50-100 USD/mes.
Reducir coste apagando staging cuando no se use y ajustando componentes medidos;
no quitar HA/backups de produccion sin aceptar explicitamente el riesgo.

La oferta Standard cambio desde el 15 de octubre de 2026 para cuentas que nunca
crearon un cluster PG/MySQL: nuevas bases sin standby/read replicas y maximo
4 GiB. Desde el 30 de noviembre aplica a todas las cuentas para nuevos clusters.
No basar una compra nueva en el precio historico Standard HA de 60 USD.

Fuentes: [App Platform](https://docs.digitalocean.com/products/app-platform/details/pricing/),
[PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/),
[Valkey](https://docs.digitalocean.com/products/databases/valkey/details/pricing/),
[Spaces](https://docs.digitalocean.com/products/spaces/details/pricing/),
[anuncio de planes](https://docs.digitalocean.com/release-notes/upcoming/dbaas-plan-changes/).

## Diferencia con lo implementado y orden de trabajo

1. Las specs actuales incluyen SEIS servicios, BFF privados, routing por host/path
   y opcion de VPC. Faltan dominios/IDs, DB/cache reales, tamanos y secretos.
   Todos los servicios siguen con una replica y los jobs apagados. No tratarlas
   como este diseno ya desplegable ni activar sus placeholders.
2. Antes de ampliar replicas: TLS de Valkey pendiente en el cliente Go actual;
   limites frontend aun en memoria; auditar reconcilers, goroutines y trabajos
   al arrancar payments/withdrawals/engine, idempotencia y locks. No aumentar
   replica_count sobre el codigo actual sin estas pruebas.
3. Validar rollback y corte, restaurar una copia representativa en PG17 Advanced,
   TLS real de todos los drivers, refresh de reportes, permisos y ultimo dato.
4. Integrar ambos frontends/BFF con backend privado; probar OTP/JWKS, arbol, ban
   sin recolocacion, saldos, pendientes Stripe y retiros con identidad verificada.
5. Ejecutar carga 1.100 sesiones con mezcla realista y escritura financiera de
   prueba; verificar p95/p99, consistencia y capacidad durante un rolling deploy
   y failover de DB. Medir y ajustar antes del go-live.
6. Crear recursos solo despues de aprobar coste y cumplimiento; Terraform/App
   Specs completos, CI protegido y despliegue staging primero. Produccion requiere
   aprobacion humana y restauracion/rollback ensayados.
