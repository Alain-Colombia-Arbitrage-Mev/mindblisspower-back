# Despliegue en Railway, sin encerrar los datos en Railway

Verificado contra documentacion oficial el 2026-10-23. Ningun proyecto ni secreto
real se creo en Railway desde esta tarea. [Guia general](README.md).

## Recomendacion operativa

Usar Railway como ejecutor de contenedores, Git como fuente, registro privado
propio para releases, PostgreSQL estandar con las extensiones necesarias, y
backups cifrados en OTRA cuenta/proveedor S3 compatible. Guardar tambien una copia
descargada y la identidad age offline. Mantener dominio/DNS bajo control propio.

La facilidad de Railway no reemplaza revision de roles, backups, observabilidad
ni recuperacion. Railway NO ejecuta Compose directamente: cada servicio se
traduce a un servicio del proyecto, y `depends_on` no existe; respetar el orden
DB/roles/restauracion -> motor/APIs -> frontends, con healthchecks y reintentos de
despliegue. [Mapeo Compose](https://docs.railway.com/guides/docker-compose).

## Pasos

1. Crear proyecto y dos ambientes VACIOS: `staging` y `production`. No duplicar
   configuracion LIVE sin revisar: la duplicacion incluye variables. Cada ambiente
   recibe su DB, claves Cognito/Stripe, volumen y prefijo de backup independiente.
   [Ambientes](https://docs.railway.com/environments).
2. Construir/probar/publicar las ocho imagenes con `release.mjs`; usar el MISMO
   digest aprobado en staging y produccion. Crear servicios de imagen Docker
   privada. Railway soporta GHCR y otros registros; actualmente las imagenes
   privadas requieren plan Pro. No publicar codigo/imagenes privadas para evitar
   ese requisito. [Servicios e imagenes](https://docs.railway.com/services).
3. Crear `postgres` desde la imagen Timescale fijada de `project.env.example`, con
   volumen `/var/lib/postgresql/data`, `POSTGRES_DB`, `POSTGRES_USER`, password
   aleatorio y preloads `timescaledb,pg_stat_statements`, como en Compose. No crear
   proxy TCP publico para uso ordinario. Es una DB PERSONALIZADA administrada por
   nosotros, no equivale automaticamente al Postgres mantenido por Railway.
4. Restaurar/provisionar esquema y roles revisados antes de iniciar aplicaciones.
   No dar `${{postgres.DATABASE_URL}}` del superusuario a todos los servicios.
   Crear DSNs por rol con host `${{postgres.RAILWAY_PRIVATE_DOMAIN}}`, usuario,
   password codificado y nombre de DB del ambiente.
5. Crear `redis` privado con password y limites del Compose. Solo cache/limites;
   no agregar colas o contabilidad a este Redis efimero sin redisenar persistencia.
6. Crear `engine`, `api`, `payments`, `withdrawals`, `client`, `admin` segun la tabla.
   Copiar variables del servicio correspondiente y cambiar hostnames Docker por
   dominios privados Railway. NO copiar archivos `*.env` al repositorio.
7. Provisionar mTLS: SAN del servidor incluye `engine.railway.internal`; volumen
   privado pequeno `/run/tls` por servicio, uno para servidor y otro para cliente.
   Subir solo sus archivos con CLI autenticada, preservar/verificar propietario y
   modo que permitan lectura al UID 65534 o 65532. La clave de CA NO se sube.
   Los volumenes se montan como root: resolver ownership en aprovisionamiento bajo
   control del operador; NO dejar `RAILWAY_RUN_UID=0` para saltarse el problema.
   No desplegar si la identidad aun no puede leerse.
8. Generar dominios HTTPS para cliente, admin y un edge de webhooks. NO publicar
   motor, gRPC, DB, Redis ni la API privada de pagos/retiros. Se puede usar una
   imagen `edge` con `CLIENT_UPSTREAM=client.railway.internal:3000`,
   `ADMIN_UPSTREAM=admin.railway.internal:3000` y
   `PAYMENTS_UPSTREAM=payments.railway.internal:9095`. El archivo incluido deja
   SOLO `POST /api/webhooks/stripe` para el host `WEBHOOK_HOST`.
   Railway termina TLS delante del contenedor: definir
   `WEBHOOK_HOST=http://HOST_PUBLICO_DEL_WEBHOOK` para el listener interno 80 y
   configurar el dominio publico Railway con HTTPS hacia ese puerto. En Stripe
   registrar SIEMPRE la URL `https://.../api/webhooks/stripe`. Usar hosts internos
   `http://client.edge.invalid` / `http://admin.edge.invalid` para los otros dos
   bloques de ese edge; frontend/admin usan sus dominios Railway directos.
   No activar auto-HTTPS/redirect de Caddy detras del terminador TLS de Railway.
   En Railway no exponer todo payments para simplificar la URL del webhook.
9. Crear `backup` como cron job y ejecutar primero un backup manual + restore
   drill fuera de Railway. Configurar alertas y retencion; despues activar trafico.

### Servicios y puertos

| Servicio | Puerto / bind | Healthcheck | Publico |
| --- | --- | --- | --- |
| client | `PORT=3000`, `HOSTNAME=::` | `/login` | Si, HTTPS |
| admin | `PORT=3000`, `HOSTNAME=::` | `/login` | Si, HTTPS |
| api | `PORT=3000`, `API_LISTEN_HOST=::` | `/health` | No |
| engine | `HTTP_LISTEN_ADDR=[::]:9090`, `GRPC_LISTEN_ADDR=[::]:50051` | `/health` | No |
| payments | `PAYMENTS_HTTP_ADDR=[::]:9095` | `/health` | No |
| withdrawals | `WITHDRAWALS_HTTP_ADDR=[::]:9097` | `/health` | No |
| postgres | 5432, privado | Verificar DB y extensiones | No |
| redis | 6379, privado | PING autenticado | No |
| backup | Sin listener | Job termina con codigo 0 solo al completar | No |

Fijar `PORT` explicitamente al puerto real de cada HTTP service para el
healthcheck/enrutamiento Railway. No todos los binarios Go leen `PORT`: sus
variables de direccion son las de la tabla. Para dominios internos usar el puerto
real, sin traduccion de puertos. Comprobar IPv6/dual stack; `localhost` no permite
conexion entre servicios. [Red privada](https://docs.railway.com/networking/private-networking).

Variables cruzadas de frontend/admin, ejemplo:

```dotenv
VP_PAYMENTS_URL=http://payments.railway.internal:9095
VP_WITHDRAWALS_URL=http://withdrawals.railway.internal:9097
VP_ENGINE_HTTP_URL=http://engine.railway.internal:9090
PAYMENTS_SERVICE_TOKEN=${{payments.PAYMENTS_SERVICE_TOKEN}}
DEMO_LOGIN_ENABLED=0
VP_FORWARD_ID_TOKEN=1
```

API:

```dotenv
VP_ENGINE_GRPC_URL=https://engine.railway.internal:50051
VP_ENGINE_HTTP_URL=http://engine.railway.internal:9090
ENGINE_MTLS_REQUIRED=true
VP_ENGINE_TLS_CA=/run/tls/ca.crt
VP_ENGINE_TLS_CERT=/run/tls/client.crt
VP_ENGINE_TLS_KEY=/run/tls/client.key
```

En todos mantener los demas controles de `compose.yml`: identidad verificada,
BMP obligatorio, allowlists correctas, `ENV=production` real, sin login demo.
El issuer de withdrawals y la audiencia Cognito deben corresponder al mismo
ambiente. Configurar tambien callbacks y dominios en Cognito y endpoints Stripe.

Los volumenes de certificados pueden limitar replicas en Railway. Mantener motor
en UNA instancia por los jobs, no escalar servicios con volumen asumiendo que
funcionan como frontends stateless. Para escalar API con mTLS sin volumen, definir
antes un mecanismo de secretos efimeros/gestor de certificados; no incrustar claves
en imagenes ni desactivar mTLS. [Volumenes](https://docs.railway.com/volumes).

### Si Railway construye desde Git

Preferimos imagenes probadas y promovidas por digest. Como alternativa:

| Servicio | Repositorio / Root Directory | Dockerfile / variable de build |
| --- | --- | --- |
| client | `mindblisspowerfront` / `/` | `Dockerfile` |
| admin | `mindblisspower-admin` / `/` | `Dockerfile` |
| api | `backend` / `/app` | `Dockerfile` |
| engine | `backend` / `/vp-engine` | `deployments/Dockerfile`, `CMD=vp-engine` |
| payments | `backend` / `/vp-engine` | `deployments/Dockerfile`, `CMD=vp-payments` |
| withdrawals | `backend` / `/vp-engine` | `deployments/Dockerfile`, `CMD=vp-withdrawals` |
| backup | `backend` / `/deploy/portable/backup` | `Dockerfile`, config `railway.json` |
| edge | `backend` / `/deploy/portable` | `Dockerfile.edge` |

Para rutas no convencionales fijar `RAILWAY_DOCKERFILE_PATH` respecto a la raiz
efectiva del servicio. El Dockerfile Go declara `ARG CMD`: Railway puede inyectar
esa variable de build. Revisar en logs el binario resultante; no aceptar el
default `vp-engine` para payments. No establecer build args con secretos.
[Dockerfiles y variables de build](https://docs.railway.com/builds/dockerfiles).

## Backup manual y programado

En `backup` configurar `DATABASE_URL` PRIVADA del rol de backup, `DEPLOY_ENV`,
destinatario publico `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_URI` de OTRO proveedor,
endpoint HTTPS, credenciales de subida limitadas y region. OMITIR
`BACKUP_OUTPUT_DIR`: el disco local del job es efimero, no una segunda copia.
No montar la clave age privada en ese servicio. El proceso necesita escribir
temporalmente ciphertext en `/work`, que ya pertenece al usuario postgres de la
imagen; dimensionar almacenamiento efimero segun el dump y mantener `USER postgres`.

Usar cron `0 */6 * * *` UTC (00/06/12/18 UTC), reinicio `NEVER`, sin healthcheck
HTTP ni dominio. `backup/railway.json` contiene esa configuracion si el origen es
ese subdirectorio Git. Para imagen preconstruida configurar esos valores en UI.
Una ejecucion anterior que no termine puede hacer que Railway omita la siguiente:
alertar por antiguedad del ultimo manifiesto, no solo por estado del despliegue.
[Cron jobs](https://docs.railway.com/cron-jobs).

Para ejecutar una copia inmediata, lanzar una ejecucion manual del mismo job y
verificar salida `Backup complete`, manifiesto remoto, bytes y descarga. No usar
`railway run` local con host privado pensando que el comando corre dentro de
Railway; las referencias `*.railway.internal` no resuelven desde el laptop.

Activar adicionalmente snapshots del volumen en Railway. Son una proteccion
operativa, NO nuestra estrategia de salida: el dump logico cifrado es el que
restauramos en Docker u otro proveedor. La disponibilidad de PITR nativo depende
de la imagen PostgreSQL mantenida por Railway; no asumirlo al desplegar Timescale
custom. Para nuestro contenedor se requiere instalar/probar pgBackRest/WAL
independiente, o validar una alternativa administrada compatible antes de cambiar
de imagen/extensiones. [Capas de backup](https://docs.railway.com/guides/postgres-backups-restores),
[PITR y sus requisitos](https://docs.railway.com/volumes/point-in-time-recovery).

## Salir de Railway

1. Disponer de imagenes/digests en un registro independiente, fuentes y manifiestos.
2. Levantar `compose.yml` + `compose.production.yml` en un host con Docker y disco
   cifrado. Restaurar la copia mas reciente en una DB nueva, roles y ACL revisados.
3. Recuperar secretos desde el gestor propio, claves de cifrado y archivos externos
   (KYC, adjuntos). Redis se regenera; no migrar caches como si fueran dinero.
4. Validar transacciones recientes; para corte definitivo pausar escritores,
   completar sincronizacion final/WAL o exportacion final, y evitar que ambos
   proveedores procesen pagos o cron financieros al mismo tiempo.
5. Cambiar DNS/DSNs/webhooks y monitorear. Conservar el origen para rollback bajo
   control de acceso; NO borrarlo como parte de una prueba.

El equipo conserva las imagenes OCI, SQL/dumps cifrados, claves y contratos de
entorno. Railway puede sustituirse; Cognito/SES/Stripe/BMP siguen siendo contratos
externos que tambien necesitan planes de contingencia, no quedan resueltos por Docker.
