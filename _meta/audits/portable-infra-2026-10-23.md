# Infraestructura portable y recuperacion - 2026-10-23

## Cambios

Rama independiente `feature/portable-docker-infra-20261023`, sobre la revision
del arbol `812db3c`. No se modifica el pipeline AWS anterior ni se despliega fuera
del equipo local.

- Nuevo stack `deploy/portable`: backend Bun, motor/cobros/retiros Go, cliente,
  admin, PostgreSQL/Timescale, Redis, edge HTTPS y contenedor de backups.
- Archivos separados para staging/produccion; volumen persistente por proyecto,
  sin puertos publicos de DB/Redis/APIs privadas ni bind mounts de codigo.
- Build/manifiesto de ocho imagenes con SHA de tres repos; lock por digest para
  promover el mismo artefacto y poder volver a una release anterior.
- Diez plantillas por servicio fuera de Git, init sin sobrescrituras y validacion
  de roles distintos, entorno Stripe/Cognito/BMP, identidad obligatoria, tokens,
  raiz canonicamente configurada y ausencia de placeholders.
- API Bun ahora admite identidad mTLS con CA verificada, sin fallback inseguro
  cuando se solicita mTLS. Nuevo bind `API_LISTEN_HOST` para red privada dual stack.
  Sin esa configuracion conserva compatibilidad con QA anterior.
- Identidades de servidor/cliente separadas, CA offline y validacion de cert/key,
  proposito, SAN, CA compartida y vigencia minima.
- Copia PostgreSQL custom + roles sin passwords, streaming cifrado age, hashes,
  manifiesto final, destino S3 compatible externo y opcional copia local.
- Restaurador solo acepta DB NUEVA con nombre *_restore_*, confirmacion exacta,
  destino vacio, hash y tamano validos; no usa DROP/clean. Preserva soporte Timescale.
- No se restauran owners/ACLs automaticamente; roles/RLS/grants requieren revision.
- Workflow de pruebas independiente de AWS, sin secretos ni publicacion de backups.

## Verificacion local

- 23 pruebas de politica/configuracion e independencia de volumenes aprobadas.
- Build Docker del contenedor de backup aprobado y drill sintetico con PostgreSQL
  17.10 / Timescale 2.27.2 aprobado: exportacion/descifrado/restauracion, roles,
  conservacion de L/R y cuenta bloqueada/descendiente, sumas e hypertable.
- Casos negativos aprobados: destinatario de cifrado ausente, confirmacion
  incorrecta, destino poblado/no habilitado y archivo cifrado alterado. El drill
  elimina solo su contenedor/red temporal, nunca la DB recuperada.
- 6 pruebas unitarias del transporte mTLS aprobadas; typecheck Bun aprobado.
- Handshake HTTP/2 real con certificados sinteticos aprobado; rechazo de cliente
  sin certificado y servidor con hostname incorrecto.
- Suite Bun Docker: 28 tests aprobados y 12 probes del pentest sintetico incluido.
- Edge Caddy: configuracion valida y 9 probes aprobados: seis rutas/metodos
  privados bloqueados, POST webhook sin firma rechazado y login admin/cliente.
- Smoke del stack QA existente: 24 probes HTTP aprobados tras actualizar API.

No se repite auditoria financiera ni prueba de capacidad de 1.100 usuarios. Los
frontends no cambian en esta rama; sus Dockerfiles existentes se reutilizan.
Las pruebas locales de workflow NO significan que GitHub Actions haya corrido.

## Datos reales y pendientes

Se consulto SOLO LECTURA el tamano/extensiones de la DB historica en
`mindbliss-local-recovery-20261022`: 12.142.300.307 bytes. No se hizo pg_dump real,
no se alteraron posiciones, usuarios, comisiones ni volumenes de esa copia.

Las copias del drill NO son copias de clientes: solo datos sinteticos; su caso
negativo deja intencionalmente ciphertext corrupto en `artifacts/`, ignorado por
Git. Las claves sinteticas y manifiestos locales no se publican.

Antes de produccion siguen siendo obligatorios:

1. Registro privado accesible y digests publicados; secretos reales por ambiente,
   identidades/rotacion y roles/grants/DB importada revisados.
2. Bucket externo propio, credenciales limitadas, retencion/immutabilidad, backup
   REAL y restore REAL en otro host con medida de RTO/RPO y validacion contable.
3. WAL/PITR continuo probado para transacciones recientes. El dump cada 6 horas
   no ofrece RPO de minutos; el contenedor Timescale custom no hereda PITR de una
   plantilla Railway. No se ha instalado/configurado pgBackRest en esa imagen.
4. Programacion/alertas de backups, disco, lag WAL y certificados; aun no activas.
5. Acceso/callbacks Cognito, entrega OTP, webhook Stripe, contratos BMP y archivos
   KYC externos. Docker no los sustituye ni exporta automaticamente.
6. Prueba de carga y recursos ajustados al trafico real; no se certifica capacidad
   por disponer de contenedores ni por el limite de memoria de ejemplo.

Runbooks: `deploy/portable/README.md` y `deploy/portable/RAILWAY.md`, con referencias
primarias consultadas para comportamiento de Railway, Compose y PostgreSQL.
