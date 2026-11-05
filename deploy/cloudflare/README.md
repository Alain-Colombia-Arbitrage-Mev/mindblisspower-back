# Mindbliss: Cloudflare + PlanetScale

## Preparación vigente del núcleo

El 25 de octubre de 2026 se autorizó preparar portales, API y servicios Go en
Workers y Containers, con revisión de costo antes de activarlos. Chatwoot queda
fuera de esta etapa. Consultar el [plan y presupuesto del núcleo](CORE-DEPLOYMENT-PLAN.md)
para la topología, escenarios locales y condiciones pendientes. No se ha
activado un despliegue ni se autoriza reanudar operaciones financieras.

Las secciones siguientes conservan el registro de la importación histórica y
la propuesta inicial. No son un inventario actual de la base curada ni una
instrucción para volver a restaurar o reemplazar datos.

## Registro de la propuesta inicial

Decision del usuario: 2026-10-24. Destino objetivo: Cloudflare para aplicaciones
y PlanetScale para PostgreSQL. Sustituye la propuesta DigitalOcean; no implica
que Cloudflare ya este desplegado.

Estado actualizado 2026-10-25: existe la cuenta Cloudflare y una conexion
PlanetScale PostgreSQL 18.6 con TLS y certificado verificado. El usuario autorizo
la importacion del archivo Docker verificado. Tras ampliar almacenamiento, la
importacion historica termino y paso las verificaciones de las 61 tablas, arbol,
usuarios, paquetes, wallets y secuencias. Esto NO valida su vigencia: los datos
son de junio/julio y NO corresponden a la RDS reciente de septiembre. Mantener
esta copia como historica; NO depurarla, reemplazarla ni usarla como definitiva.
El lanzamiento sigue bloqueado hasta recuperar y conciliar la fuente reciente.
Consultar [el registro de importacion](IMPORT-20261025.md) y la
[verificacion de procedencia](FRESHNESS-20261025.md). El dominio confirmado es
mindblisspower.com. Wrangler autentico una unica cuenta y listo Hyperdrive en ella.
No se verificaron Zone ID, modalidad Metal/red, recursos, tarifa ni entorno
asignado a esa DB. No adivinarlos ni publicar secretos.

La configuracion privada backend/.env.local define DATABASE_URL hacia PgBouncer
en 6432, PGBOUNCER=true y DATABASE_POOL_MAX=5 para la API Bun. No arrancar servicios
contra una DB vacia. El limite es por instancia Bun, no un presupuesto global de
Go, Hyperdrive y replicas. El archivo y sus copias .env*.local estan ignorados por
Git. Se normalizo la URI renovada sin mostrarla y se verifico el archivo final
con Node y Bun mediante databaseOptions: conexion correcta, READ ONLY, pool 5 y
PgBouncer 6432. El rol observado no puede crear esquemas ni objetos en public;
no sirve como rol de restauracion. Comprobar la revocacion de la credencial
anterior; no documentar valores ni confundir conexion exitosa con revocacion.

Preparacion de restauracion: [procedimiento y preflight](RESTORE.md). El
planificador restore_plan.py sigue siendo solo lectura, sin apply. La importacion
autorizada usa un procedimiento manual separado, limitado al hash del archivo
historico: se restauro primero en un nuevo Docker PG18.6 aislado. El original
no responde por TCP y no se reinicio ni modifico. El usuario declara credenciales
rotadas; conectar correctamente no demuestra revocacion ni actualiza Hyperdrive.
La copia contiene datos hasta julio y cero eventos/intentos Stripe: conciliar
los movimientos posteriores antes de habilitar operaciones financieras.

### Configuracion local tras renovar credenciales

`node deploy/cloudflare/normalize-env.mjs --check` valida la configuracion privada
sin conectar ni mostrar la URI. `--apply` convierte una unica URI suelta en
DATABASE_URL, conserva sslmode=verify-full y adapta sslrootcert=system al driver
Postgres.js (Node usa su almacen de CA; el parametro libpq causaba 42704).
No acepta CA personalizada, opciones desconocidas, destinos ambiguos ni pool >5.
Respeta el puerto de la URI suministrada: 5432 directo implica PGBOUNCER=false,
6432 implica true. Guarda atomicamente solo .env.local ignorado por Git, sin
copias del secreto ni cambios en las variables legacy separadas. No valida por
si mismo la vigencia o revocacion de contrasenas. Mantener la app detenida hasta
completar la importacion, verificar integridad y revisar grants/RLS por servicio.

Wrangler quedo autenticado y el inventario solo lectura encontro Hyperdrive
planetscale-mindbliss-main-35ro: puerto 5432, cache disabled, limite de origen 15.
Esto comprueba configuracion, NO una consulta real a traves del binding ni la
rotacion de su password. No se desplego Worker ni se cambio DNS.

## Componentes y alcance

| Componente existente | Destino propuesto | Estado |
| --- | --- | --- |
| Cliente y admin Next.js 16 | Workers, tras validar el adaptador | Sin adaptar ni desplegar |
| API Bun/Hono | Containers, conservando su runtime | Docker probado; red Cloudflare pendiente |
| Engine Go | Containers privado HTTP/gRPC mTLS | Sin desplegar |
| Payments y withdrawals Go | Containers, solo webhook Stripe publico | Sin desplegar |
| Base relacional | PlanetScale PostgreSQL, NO MySQL/Vitess ni D1 | Copia historica importada/verificada; NO es la fuente definitiva |
| Lecturas directas de Workers | Hyperdrive | Recurso existente, sin binding de app ni prueba end-to-end |
| Backups independientes | pg_dump cifrado, destino externo al proveedor DB | Archivo real cifrado local; falta destino externo y schedule cloud |

Los servicios Go/Bun pueden usar su driver PostgreSQL por TLS directamente;
Hyperdrive es para el acceso desde Workers, no un runtime ni el alojamiento DB.
No modificar posiciones, ledger, comisiones o reglas de ban durante este cambio.
Mantener apagados jobs financieros, ROI, reconciliacion y comunicaciones.

La [integracion oficial](https://developers.cloudflare.com/hyperdrive/planetscale/)
permite crear PlanetScale PostgreSQL desde Cloudflare y facturarlo en esa cuenta.
La base sigue alojada/soportada por PlanetScale y se cobra por separado. Completar
la creacion o vinculacion de la cuenta/organizacion que solicite el flujo; no
asumir que tener Cloudflare significa que ya existe una organizacion PlanetScale.
No ejecutar la creacion hasta aprobar region, precio y plan.

## Controles de entrega

DEPLOYMENT_PROVIDER=cloudflare seleccionado en backend, cliente y admin. Los
publicadores DOCR y el CD App Platform conservan sus guardas digitalocean; no
se ejecutan con la seleccion cloudflare. DO_LAUNCH_APPROVED=false sigue en
staging y production. No borrar DOCR mindblisss, secretos ni recursos existentes.
Conservar Docker/Compose como portabilidad y evidencia, no como un despliegue
Cloudflare listo. Cambiar esta variable NO crea un publicador Cloudflare.

Deshabilitados en GitHub el 2026-10-24: build/deploy AWS de backend y deploy AWS
de cliente/admin. Siguen activos los checks de seguridad, PostgreSQL, Go race
y Docker sintetico. Esto no detiene servicios, contenedores o datos existentes.
No integrar ni ejecutar las PRs DigitalOcean como instrucciones de lanzamiento.

Crear la entrega Cloudflare en PRs separadas: pruebas sin secretos, imagenes
probadas por digest y publicacion protegida, staging antes de production y
aprobacion humana. No ejecutar migraciones ni restauraciones durante el arranque
o un deploy de imagen. DOCR no figura entre los registries externos admitidos
directamente por Containers; revisar la [gestion de imagenes](https://developers.cloudflare.com/containers/guides/image-management/)
y publicar el mismo candidato probado en el registry compatible elegido.

## Orden de preparacion

1. Confirmar en el panel la region, modalidad, recursos, coste y entorno de la DB
   ya creada. La conexion indica PG18.6: no cambiar el major ni recrear el destino
   automaticamente. El tooling conserva PG17 y agrega una imagen PG18 separada;
   los drills nativos 17, 18 y 17 a 18 se detallan en [la guia portable](../portable/README.md#postgresql-18).
   Esto no certifica aun las migraciones y pruebas de negocio del backend en PG18.
2. Crear staging con credenciales y roles separados. Verificar TLS/hostname,
   limites de conexiones, permisos, funciones, triggers y extensiones. La lista
   [actual de PlanetScale](https://planetscale.com/docs/postgres/extensions)
   incluye ltree, btree_gist, citext y pgcrypto; no es una certificacion de nuestra
   restauracion. ltree documentado alli es 1.3, mientras las fixtures actuales
   usan 1.2: probar la version real y no ejecutar ALTER EXTENSION automaticamente.
3. Restaurar una copia verificada en una DB NUEVA y medir la ultima transaccion,
   filas, montos, secuencias, propietarios, posiciones y placeholders de baneados.
   No tocar mindbliss-local-recovery-20261022 ni la QA existente. Sin Timescale
   en el destino; cualquier conversion requiere un procedimiento independiente.
   El restaurador portable NO acepta la DB postgres ni schemas preexistentes del
   proveedor: no relajar esas guardas para importar en PlanetScale. Preparar un
   procedimiento de importacion especifico y revisado antes de usar datos reales.
4. Probar backup, PITR y restauracion hacia otra DB. PlanetScale documenta
   [restauracion a ramas nuevas](https://planetscale.com/docs/postgres/backups);
   comprobar las extensiones despues de restaurar, la ventana real de recuperacion
   y el ultimo punto disponible. Mantener copias cifradas fuera de la cuenta DB,
   claves offline y alertas; no declarar un RPO/RTO antes del ensayo.
5. Validar Containers con datos sinteticos: red privada y acceso a DB, gRPC/mTLS,
   JWT, secretos por entorno, reinicios, arranque en frio, apagado ordenado y
   limites. No asumir DNS/red Compose ni autoscaling por trasladar los Docker.
6. Probar Next.js/Workers en ramas separadas, sin reemplazar el build Docker.
   Verificar proxy, sesiones, origen/CSRF, JWT, OTP y lecturas. Separar clientes
   Hyperdrive con/sin cache; auth, permisos, pagos, saldos y posiciones requieren
   lecturas frescas. Hyperdrive no invalida automaticamente tras escribir:
   [comportamiento oficial](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
7. Confirmar auth/OTP externos operativos, trazabilidad Stripe e idempotencia.
   Cognito/SES/BMP siguen siendo dependencias: elegir Cloudflare no las migra.
   Medir carga representativa de 1.100 sesiones, latencia DB y p95/p99 antes
   de dimensionar. Separar ejecutor financiero y verificar locks antes de escalar.
8. Aprobar coste, cumplimiento, recuperacion y staging antes de crear produccion.
   No crear recursos facturables, cambiar DNS, enviar OTP, cobrar ni mover datos
   reales como parte de esta preparacion.

## Cumplimiento pendiente

Cloudflare incluye Workers, Hyperdrive y R2 en su [alcance PCI publicado](https://www.cloudflare.com/trust-hub/compliance-resources/pci-dss/).
Containers no figura en la lista publica consultada: confirmar su AoC y matriz
de responsabilidades, sin asumir ni cobertura ni exclusion por esa ausencia.
La cobertura [PCI de PlanetScale](https://planetscale.com/docs/security#pci-compliance)
depende de la modalidad contratada y controles. Facturacion Cloudflare no
transfiere certificaciones. La app no queda certificada por usar esos proveedores.

## Dominios

Confirmado solo mindblisspower.com para cliente production. Propuestas pendientes
de aprobacion: admin.mindblisspower.com y api.mindblisspower.com; staging en
staging.mindblisspower.com, admin-staging.mindblisspower.com y
api-staging.mindblisspower.com. Ningun registro DNS fue cambiado por esta decision.
