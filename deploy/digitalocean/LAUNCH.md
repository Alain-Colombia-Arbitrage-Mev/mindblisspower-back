# Lanzamiento con Docker + GitHub Actions + App Platform

Guia INACTIVA: el usuario eligio [Cloudflare + PlanetScale](../cloudflare/README.md)
el 2026-10-24. DEPLOYMENT_PROVIDER=cloudflare y DO_LAUNCH_APPROVED=false bloquean
esta ruta. No cambiar esas variables ni crear apps/DB DigitalOcean siguiendo
los pasos historicos de este archivo sin una nueva decision explicita.

Actualizado: 2026-10-24. Proyectos confirmados por el usuario: `mindbliss`
(staging) y `mindbliss-prod` (produccion). Los proyectos no son las apps.
No se han publicado imagenes en DOCR ni desplegado aplicaciones desde esta tarea.

## Artefactos

| Repo GitHub | Workflow manual | Imagenes |
| --- | --- | --- |
| mindblisspower-back | container-images | api, engine, payments, withdrawals, backup |
| mindblisspowerfront | container-images | client |
| mindblisspower-admin | container-images | admin |

Todos los nombres en DOCR tienen prefijo `mindbliss-`. Las siete imagenes usan
Linux AMD64 y usuario no root. Las bases de las aplicaciones estan fijadas por
digest. El backup es una herramienta operativa: NO se agrega como servidor ni
job al App Spec, NO se ejecuta en un despliegue. PostgreSQL/Valkey productivos
son administrados, no se publican como contenedores de App Platform. El Caddy
portable sigue disponible para VPS; App Platform ya proporciona su edge HTTPS.

Cada publicacion construye candidatos una sola vez, prueba esos mismos
candidatos y luego los sube. Las etiquetas incluyen SHA + run ID + intento,
evitando sobreescribir una version al repetir el workflow. El lock registra
digest remoto, repo origen y SHA; verifica que el config digest remoto coincide
con el ID local probado. Los builds usan `provenance=false` para permitir load
en Docker de runners estandar; aun NO generan SBOM/firmas/attestations de release.
No confundir los labels OCI de origen con una firma verificada del artefacto.

## 1. Configuracion GitHub

Mantener PRs y checks obligatorios de [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md).
Crear environment `container-images` en los tres repos, con revisores si el
plan lo permite, permisos restringidos y solo rama predeterminada. Variables:

| Nombre | Donde | Contenido |
| --- | --- | --- |
| DEPLOYMENT_PROVIDER | Variable de los tres repos | digitalocean |
| DOCR_REGISTRY | Variable de los tres repos | Nombre exacto del mismo registro DOCR |
| DOCR_USERNAME | Secreto environment container-images | Usuario/email autorizado del registro |
| DOCR_WRITE_TOKEN | Secreto environment container-images | Credencial de publicacion de minimo privilegio |

No compartir tokens por chat, no usar tokens de otra aplicacion y no entregar
credenciales DB, Stripe o BMP a los jobs de construccion. Crear DOCR con
capacidad para al menos siete repositorios. El publisher antiguo GHCR se
reemplazo por `container-images.yml`; no activar dos publicadores para la misma
release. Los workflows AWS siguen fail-closed salvo seleccion explicita `aws`.

## 2. Publicar imagenes

Despues de integrar las PRs revisadas, ejecutar `container-images` desde la
rama predeterminada de cada repo (main backend/cliente, master admin).
Primero pasan los gates existentes. Backend prueba sus cuatro servicios reales
en redes sinteticas y restaura un backup cifrado sobre PostgreSQL nativo.
Cliente/admin prueban `/login` en su runtime exacto, sin red ni secretos.
Esto NO equivale a probar login Cognito, OTP o permisos DB reales.

Se generan tres artefactos: `backend-image-lock`, `client-image-lock` y
`admin-image-lock`. Backend y cliente actualmente son repos publicos; admin es
privado. Los artefactos heredan el acceso del repositorio, NO asumir privacidad.
DOCR debe seguir siendo privado. Estos locks contienen solo metadata
de imagenes, nunca claves ni configuracion de la aplicacion. Retencion: 30 dias.
Conservar la release aprobada por mas tiempo fuera de los artefactos efimeros.

## 3. Formar una release

Reunir los tres JSON descargados de ejecuciones aprobadas:

```sh
node deploy/digitalocean/release.mjs assemble backend-image-lock.json client-image-lock.json admin-image-lock.json --output deploy/digitalocean/releases/r20261024-01.json
```

El comando rechaza registries mezclados, digests cero/tags, componentes duplicados
o ausentes y commits backend inconsistentes. No sobreescribe un archivo existente.
La release se revisa y publica por PR en backend; no contiene secretos. Conservar
las imagenes referenciadas en DOCR: la limpieza del registro no debe borrarlas.

## 4. Bootstrap de cada app (una sola vez)

Faltan datos de cuenta: nombre DOCR, UUID de VPC/proyectos/apps y los tres
dominios de cada entorno. No adivinarlos. Los App Specs tienen seis componentes:
cliente/admin/Bun/engine/payments/withdrawals. Engine y retiros privados; ingress
por hostname, y payments solo expone la ruta EXACTA del webhook firmado.

`app-spec.mjs` mantiene modo plantilla sin argumentos adicionales. No desplegar
su salida por defecto: contiene digests cero, dominios `.invalid` y `REPLACE_*`.
Para renderizar con imagenes reales, un archivo de configuracion NO secreto
debe contener `{ "hosts": { "client": "...", "admin": "...", "api": "..." },
"vpcId": "UUID_REAL" }`:

```sh
node deploy/digitalocean/app-spec.mjs staging --release deploy/digitalocean/releases/r20261024-01.json --config deploy/digitalocean/runtime/staging-config.json
```

Completar TODOS los secretos en un archivo privado bajo `runtime/` (ignorado por
Git) o el control panel antes de crear la app. NUNCA subir ese archivo como
artefacto CI. Verificar la spec con doctl y revisar el plan/coste; asignar la app
al proyecto correcto. Esta tarea NO ejecuta automaticamente `apps create`.
El nombre de app debe ser `mindbliss-staging` o `mindbliss-production`.

Provisionar PG17/Valkey/almacenamiento separados, roles minimos, TLS real,
trusted sources y restauracion verificada. Usar CA del sistema para Advanced
cuando corresponda, no una CA sintetica. El DSN/API debe usar verify-full; los
frontends deben reenviar JWT al backend. Verificar los App Clients Cognito y
sus redirects/logout para cada hostname antes de aceptar usuarios.
La clave PAYMENTS_SERVICE_TOKEN de cliente/admin/payments debe corresponder a
SERVICE_TOKEN de withdrawals. No habilitar DEMO ni debilitar autenticacion.

Inicialmente todas las aplicaciones tienen una instancia: los limites OTP aun
son locales al proceso. Mantener apagados jobs financieros, ROI, reconciliacion
y comunicaciones. Aun falta Valkey TLS/distribuir limites y auditar tareas
concurrentes antes de escalar. Las pruebas de carga reales y alcance PCI siguen
siendo requisitos. Esta configuracion NO certifica 1.100 sesiones concurrentes.

## 5. Despliegue continuo controlado (solo imagenes)

El workflow `app-platform-deploy` vive SOLO en backend para serializar cambios.
Crear los environments `staging` y `production` en GitHub, cada uno con su token
de deploy y sus variables propias:

| Nombre | Tipo | Alcance |
| --- | --- | --- |
| DO_APP_ID | Variable environment | UUID real de la app de ese entorno |
| DO_PROJECT_ID | Variable environment | UUID real del proyecto correspondiente |
| DO_DEPLOY_TOKEN | Secreto environment | app:read/app:update/project:read necesarios; restringir privilegios |
| DO_STAGING_APP_ID | Variable production | UUID de la app staging para verificar la promocion |
| DO_STAGING_PROJECT_ID | Variable production | UUID del proyecto staging |
| DO_LAUNCH_APPROVED | Variable environment | true SOLO tras aprobar DB, auth, backups y cumplimiento |

Revisar los scopes exactos disponibles del token en la cuenta. El token de
produccion necesita leer staging para comprobar su deployment ACTIVE. No
otorgar permisos de crear/borrar bases, billing o publicar imagenes a este job.
Un environment no crea aprobacion independiente por si mismo; configurar las
protecciones disponibles segun el plan GitHub.

Ejecutar primero con `environment=staging`, ruta de release y `apply=false`.
El plan obtiene la spec en memoria, valida IDs/proyecto, VPC, seis servicios,
identidades verificadas, jobs apagados y ausencia de placeholders. No imprime
ni guarda configuracion completa o secretos del proveedor. Solo genera un
recibo con ID de release, app/proyecto y cambios de digests.

Para aplicar, repetir con `apply=true` y confirmacion `deploy-staging`.
Se necesita DO_LAUNCH_APPROVED=true. El updater preserva secretos, rutas, tamanos,
DB y VPC: SOLO cambia seis campos image.digest. Espera el deployment especifico
ACTIVE y comprueba cliente/admin `/login` y API `/health` por HTTPS.
Para production usar `deploy-production`: exige que la app independiente staging
este ACTIVE con los mismos seis digests. No reconstruye ni promueve la DB.

El script no hace retries automaticos de escrituras ni rollback automatico.
Un timeout/smoke fallido puede ocurrir DESPUES de actualizar la app: inspeccionar
el estado antes de reintentar. La concurrencia GitHub evita dos jobs de este
workflow por entorno; congelar tambien cambios manuales en la consola. La API
no proporciona aqui un compare-and-swap atomico, queda una ventana entre lectura
y escritura. Migraciones y cambios de configuracion requieren un proceso aparte.

No eliminar una version anterior ni el origen de datos hasta probar recuperacion.
Una reversion de imagen no revierte transacciones ni justifica restaurar un dump
viejo sobre una base que ya recibio ventas nuevas.

## Comprobacion local

```sh
node --test deploy/digitalocean/app-spec.test.mjs deploy/digitalocean/release.test.mjs deploy/digitalocean/deploy.test.mjs
node deploy/digitalocean/test-local.mjs --synthetic-docker
node deploy/portable/test-backup.mjs --synthetic-docker --vanilla-postgres
```

Las pruebas de CD usan una API simulada y no crean recursos. El validador
`doctl apps spec validate --schema-only` comprueba estructura, no recursos ni
secretos. Revisar por separado el resultado de las primeras ejecuciones GitHub
y DigitalOcean; no presentar las pruebas locales como un despliegue cloud.
