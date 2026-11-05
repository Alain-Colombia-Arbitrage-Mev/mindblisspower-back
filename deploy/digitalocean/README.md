# Mindbliss: preparacion local para DigitalOcean App Platform

Destino anterior, sustituido el 2026-10-24 por decision del usuario:
[Cloudflare + PlanetScale](../cloudflare/README.md). DEPLOYMENT_PROVIDER ahora
es cloudflare. Este material se conserva como pruebas Docker y propuesta
portable, NO como instrucciones para activar DigitalOcean.

Arquitectura objetivo, dimensionamiento, coste y requisitos de lanzamiento:
[ARCHITECTURE.md](ARCHITECTURE.md). Es un diseno propuesto, no infraestructura
ya desplegada. Las plantillas incluyen los seis servicios de aplicacion.

Guia operativa de imagenes, secretos, releases y despliegue protegido:
[LAUNCH.md](LAUNCH.md). Es el punto de entrada para lanzar en App Platform.

Fecha: 2026-10-24. Rama local: `feature/digitalocean-app-platform-20261024`
en backend y cliente. El usuario confirmo los proyectos cloud `mindbliss`
(staging) y `mindbliss-prod` (produccion); IDs y recursos no verificados por API.
Desde esta tarea NO se provisionaron servicios, publicaron imagenes ni
desplegaron cambios cloud. Los workflows de revision se ejecutan en las PRs
borrador [backend #4](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/pull/4),
[cliente #1](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspowerfront/pull/1)
y [admin #2](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-admin/pull/2).
Consultar los checks de su revision exacta; ninguna PR se integro desde esta
tarea. DEPLOYMENT_PROVIDER=digitalocean se configuro inicialmente en los tres
repos; la seleccion actual es cloudflare, conforme al aviso anterior.
La propuesta Terraform Alibaba queda inactiva.

## Resultado local

- Dos stacks independientes, `staging` y `production`, con las cuatro imagenes
  reales de runtime: API Bun, engine Go, payments Go y withdrawals Go.
- PostgreSQL 17.11 nativo, ltree 1.2, TLS con CA y verificacion de hostname.
  No hay Timescale en estas bases NUEVAS. NO se modifico la base recuperada.
- 17 comprobaciones por ambiente: salud, consulta DB desde autenticacion,
  rechazo sin credenciales, rechazo con solo token de servicio, JWT firmado
  de prueba, consultas financieras/arbol/retiros y firma Stripe invalida.
  mTLS real verifica cliente, CA y hostname; rechaza identidades ausentes.
- Redes backend sin salida a Internet, secretos/Stripe/identidad sinteticos.
  No se enviaron OTP, mensajes, cobros, retiros ni solicitudes BMP reales.
- Contadores de ledger, eventos del arbol y afiliados sin cambios al consultar;
  al menos cuatro conexiones backend cifradas comprobadas en `pg_stat_ssl`.
  Los jobs financieros, ROI, reconciliacion y comunicaciones estan apagados.
- Suite completa Go con race detector aprobada sobre PostgreSQL nativo. Las
  pruebas detectaron un `subpath` fuera de rango al reconciliar el arbol;
  se corrigio el limite en la vista, sin recolocar usuarios ni alterar saldos.
- Migracion de vistas materializadas comprobada: UTC, permisos, idempotencia
  y refresh inicial/concurrente. Las pruebas de politicas/specs/releases/CD se
  ejecutan sin credenciales cloud.

Esto NO certifica 1.100 usuarios concurrentes, datos reales, permisos minimos de
una DB administrada, disponibilidad multi-zona ni el runtime gVisor de App
Platform. Las bases sinteticas usan un rol administrador SOLO para las pruebas.

## Repetir las pruebas

Desde la raiz de `backend`, con Docker Linux y Node 24. Los comandos funcionan
en PowerShell; no requieren cuenta, token ni archivo `.env` real.

```sh
docker build -t mindbliss/backup:infra-20261023 deploy/portable/backup
docker build -f deploy/docker-qa/Dockerfile.postgres -t mindbliss/rds-postgres-test:20261024 .
docker build --target runtime -t mindbliss/app-platform-api:test-20261024 app
docker build --target runtime --build-arg CMD=vp-engine -f vp-engine/deployments/Dockerfile -t mindbliss/app-platform-engine:test-20261024 vp-engine
docker build --target runtime --build-arg CMD=vp-payments -f vp-engine/deployments/Dockerfile -t mindbliss/app-platform-payments:test-20261024 vp-engine
docker build --target runtime --build-arg CMD=vp-withdrawals -f vp-engine/deployments/Dockerfile -t mindbliss/app-platform-withdrawals:test-20261024 vp-engine
node --test deploy/portable/manage.test.mjs deploy/portable/release-policy.test.mjs deploy/digitalocean/app-spec.test.mjs deploy/digitalocean/release.test.mjs deploy/digitalocean/deploy.test.mjs
node deploy/digitalocean/test-local.mjs --synthetic-docker --keep
```

El ultimo comando imprime dos URLs locales de `/health` y guarda evidencia en
`deploy/digitalocean/artifacts/<id>/report.json` (ignorado por Git). El acceso
publicado SOLO permite `GET /health`; no expone administracion ni DB. Los
servicios reales permanecen en redes internas. El mock de identidad y el gateway
son herramientas locales: NUNCA se incluyen en un despliegue cloud.

Sin `--keep`, el harness elimina sus propios contenedores, datos tmpfs y redes,
tanto al terminar como al fallar. Con `--keep`, detener SOLO los contenedores del
prefijo completo impreso por esa ejecucion y luego sus tres redes. No usar
`docker system prune`, `volume prune` ni detener la QA/base historica existente.
Las bases de este harness son efimeras: no guardar transacciones reales en ellas.

## Plantillas App Platform

`app-spec.mjs` genera JSON aceptado por el validador oficial de esquema:

```sh
node deploy/digitalocean/app-spec.mjs staging
node deploy/digitalocean/app-spec.mjs production
```

Las dos plantillas pasaron `doctl apps spec validate --schema-only` sin cuenta
ni red. Esta validacion comprueba estructura, NO disponibilidad de recursos,
autenticacion del registro ni correccion de secretos.

Son plantillas, NO manifiestos listos para desplegar: contienen digests cero y
`REPLACE_*`. No ejecutarlas con `apps create` o `apps update`. Usan DOCR por
digest, puertos privados del engine/retiros y publican cliente/admin/API por
dominios separados y la ruta EXACTA del webhook firmado. No incluyen DB ni volumenes dentro de App Platform,
que [no admite almacenamiento persistente local ni volumenes](https://docs.digitalocean.com/products/app-platform/details/limits/).
Los certificados se entregan como secretos PEM de runtime; no se desactiva TLS.

El motor es un servicio privado, NO un worker: debe recibir gRPC de la API.
La red interna comunica los seis componentes de la misma app; los BFF de cliente
y admin usan las URLs privadas de payments/withdrawals/engine.
Ver [enrutamiento interno oficial](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/).
Los tamanos son provisionales y las specs mantienen UNA replica por servicio;
dimensionar y permitir replicas adicionales despues de carga realista y revisar
el presupuesto de conexiones a PostgreSQL.

## CI y promocion

El usuario eligio GitHub Actions. Activacion, checks y limites del alcance:
[GITHUB_ACTIONS.md](GITHUB_ACTIONS.md). No se migro a GitLab. CD esta preparado,
pero no se activa ni aplica sin la configuracion y aprobacion de LAUNCH.md.

- `app-platform-local.yml`: construye cuatro runtimes, valida ambos esquemas
  offline y prueba staging/production sinteticos; sin secretos cloud.
- `postgres-rds.yml`: PostgreSQL nativo, politicas, API/TLS, Go race/vet y
  revision de dependencias. Terraform mock solo si el proveedor es Alibaba.
- `container-images.yml` en los tres repos publica en DOCR solo desde la rama
  principal, manualmente y tras sus gates. Prueba el candidato antes de subirlo;
  exporta locks por digest con commit y repositorio de origen. No reconstruye
  al promover. El backend incluye la imagen portable de backup cifrado.
- `app-platform-deploy.yml` consume un release revisado: modo lectura por
  defecto, cambios solo de digest sobre apps ya configuradas, comprobacion de
  proyecto/VPC y staging ACTIVE antes de produccion. No crea infraestructura,
  no cambia secretos ni ejecuta migraciones.
- Antes de publicar/integrar, configurar `DEPLOYMENT_PROVIDER=digitalocean` en
  los tres repos. Los workflows AWS legacy de backend/cliente/admin ahora solo
  se ejecutan con seleccion EXPLICITA `DEPLOYMENT_PROVIDER=aws`: vacio, typo u
  otro proveedor no habilitan AWS. El codigo remoto anterior aun requiere esa
  variable mientras estos cambios no esten integrados.
- Configurar DOCR privado segun LAUNCH.md. Promover el MISMO
  digest probado de staging a production, revisar secretos, aprobar manualmente
  y conservar el digest anterior. No reconstruir al promover ni incluir secretos
  de runtime en imagenes o `NEXT_PUBLIC_*`.

## Pendientes antes de produccion real

1. Crear dos apps y PostgreSQL administrado con aislamiento de credenciales,
   TLS `verify-full`, CA real, trusted sources y roles por servicio sin superuser.
   Repetir restauracion y pruebas contra la instancia administrada real. Revisar
   extensiones/owners/RLS antes de migrar. No montar PGDATA Timescale en vanilla.
2. La migracion `05_postgresql.sql` NO convierte una DB Timescale existente:
   se niega si detecta la extension. Revisar conversion/restauracion en una DB
   nueva. Aplicar `69_tree_pv_truth_safe_path.sql` para actualizar la vista en
   esquemas existentes; no ejecutarlo automaticamente al iniciar aplicaciones.
   Refrescar las nuevas vistas materializadas con `05_postgresql_refresh.sql`
   antes de servir reportes; no hay retencion ni scheduler implicito.
3. Probar backup/PITR nativo y restauracion en otro destino. Ademas usar
   `pg_dump -Fc` cifrado con age hacia almacenamiento externo al proveedor,
   con manifiesto, retencion, alertas y prueba de restauracion. Ver el
   [runbook portable](../portable/README.md#backups-independientes). No hay
   backups cloud ni programadores activados por este cambio; acordar RPO/RTO.
4. Integrar Redis/Valkey administrado con TLS: el cliente cache actual solo
   configura direccion/password sin TLS. No conectarlo a un endpoint remoto
   sin revisar este soporte. Las pruebas locales NO validan esa integracion;
   la plantilla aun no configura cache administrada ni limites distribuidos.
5. Revalidar Cognito/JWKS, SES/OTP, BMP, almacenamiento KYC y Stripe de pruebas.
   Retiros en modo estricto exigen `X-VP-Id-Token` verificado ademas del token
   interno: comprobar todos los BFF antes de cortar trafico. Este cambio evita
   que solo declarar un correo permita autorizar retiros.
6. Probar login, cliente/admin, bosque y datos financieros extremo a extremo.
   Carga con mezcla realista, p95/p99, limites, conexiones y latencia DB; alertas
   y rollback ensayados. Mantener todos los jobs apagados hasta revisar un unico
   ejecutor; no habilitar ROI/cierres durante rolling deployments.
7. Revisar alcance PCI con el responsable de cumplimiento: DigitalOcean indica
   que [App Platform no es PCI DSS compliant](https://docs.digitalocean.com/products/app-platform/details/limits/).
   No almacenar ni procesar PAN/CVC en estos servicios. Usar checkout alojado
   por Stripe no permite asumir automaticamente que el resto queda fuera de
   alcance. No se ha certificado cumplimiento con estas pruebas.

Terraform DigitalOcean no esta implementado; el CD image-only si esta preparado.
Faltan recursos/IDs/secretos reales y aceptar staging antes del primer apply.
No reutilizar el Terraform de Alibaba contra otro proveedor, ni activar un
apply para completar esta prueba.
