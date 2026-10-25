# Mindbliss: Cloudflare + PlanetScale

Decision del usuario: 2026-10-24. Destino objetivo: Cloudflare para aplicaciones
y PlanetScale para PostgreSQL. Sustituye la propuesta DigitalOcean; no implica
que Cloudflare ya este desplegado.

Estado actualizado 2026-10-25: existe la cuenta Cloudflare y una conexion
PlanetScale PostgreSQL 18.6 validada SOLO LECTURA, con TLS y certificado verificado.
La DB consultada no tiene tablas de la aplicacion; esto no significa que haya
datos migrados ni que el backend este desplegado. El dominio confirmado es
mindblisspower.com. No se verificaron Account ID, Zone ID, modalidad Metal/red,
recursos, tarifa ni entorno asignado a esa DB. No adivinarlos ni publicar secretos.

La configuracion privada backend/.env.local define DATABASE_URL hacia PgBouncer
en 6432, PGBOUNCER=true y DATABASE_POOL_MAX=5 para la API Bun. No arrancar servicios
contra una DB vacia. El limite es por instancia Bun, no un presupuesto global de
Go, Hyperdrive y replicas. El archivo y sus copias .env*.local estan ignorados por
Git. Se retiro la URI antigua sin nombre de variable sin cambiar DATABASE_URL.
Comprobar la rotacion de la credencial expuesta durante el diagnostico; no
documentar su valor ni considerar su rotacion validada por una conexion exitosa.

Preparacion de restauracion: [procedimiento y preflight](RESTORE.md). El usuario
eligio como origen el Docker recuperado y confirmo que la credencial aun NO fue
rotada. El origen no responde por TCP; no se reinicio ni modifico. El planificador
es solo lectura/salida de plan, no tiene apply y bloquea antes de conectar si no
se confirma rotacion y disponibilidad. Ensayo con datos sinteticos, no importacion.

## Componentes y alcance

| Componente existente | Destino propuesto | Estado |
| --- | --- | --- |
| Cliente y admin Next.js 16 | Workers, tras validar el adaptador | Sin adaptar ni desplegar |
| API Bun/Hono | Containers, conservando su runtime | Docker probado; red Cloudflare pendiente |
| Engine Go | Containers privado HTTP/gRPC mTLS | Sin desplegar |
| Payments y withdrawals Go | Containers, solo webhook Stripe publico | Sin desplegar |
| Base relacional | PlanetScale PostgreSQL, NO MySQL/Vitess ni D1 | Conexion PG18.6 probada; sin importar datos |
| Lecturas directas de Workers | Hyperdrive | Sin configurar |
| Backups independientes | pg_dump cifrado, destino externo al proveedor DB | Drills Docker PG17/18; sin backup real ni schedule cloud |

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
