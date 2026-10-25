# Procedencia y vigencia de PostgreSQL

Fecha: 2026-10-25, America/Bogota. Objetivo: identificar la copia PostgreSQL real
mas reciente y distinguir la fecha de exportacion de la fecha de sus datos.

## Decision operativa

La PG18 importada en PlanetScale es HISTORICA, no la RDS reciente correcta.
No depurar, compactar, borrar, sobreescribir ni usar como fuente definitiva.
No arrancar aplicaciones o jobs financieros contra ella. Una transferencia
integra de datos antiguos no corrige la ausencia de movimientos posteriores.
Se conserva el origen y el backup; no hubo despliegue de aplicaciones.

## Referencia reciente de RDS

El usuario aporto evidencia historica de la instancia del 21 de septiembre:

| Registro | Conteo de referencia |
| --- | ---: |
| payments.stripe_event | 1846 |
| payments.purchase_intent | 1729 |
| mlm.transaction | 34546 |
| mlm.wallet_movement | 34546 |

Snapshot prioritario: rds:database-mindlisspower-2026-09-21-06-59.
El reporte local reportes/postgres-backups-evidence-2026-10-22.json conserva
evidencia de su existencia historica, con creacion 2026-09-21T06:59:13.872Z.
Tambien documenta un punto de restauracion observado hasta el 21 de septiembre.
Esto NO demuestra que el snapshot o PITR sigan disponibles hoy. En esta revision
no se consulto AWS ni se creo una instancia facturable.

Los conteos son una referencia de la RDS de ese dia, no una medicion del archivo
del snapshot de las 06:59. Confirmar el instante de ambas evidencias y conciliar
las diferencias por corte temporal. No fabricar filas o ejecutar pagos para
forzar una coincidencia. Recuperar primero el origen correcto y validar sus
fechas, usuarios, transacciones, ledger, Stripe y posiciones antes de importar.

## Inspeccion Docker local

Se inspeccionaron en solo lectura los contenedores, imagenes y volumenes locales.
Los contextos default y desktop-linux apuntan al MISMO motor Docker. Ubuntu WSL
no tiene otro daemon dockerd ni /var/lib/docker/volumes o PostgreSQL local.

- Original: vp-dev-db, volumen dev_vp_dev_pgdata, PostgreSQL 17, unos 13.21 GB.
  Checkpoint original 2026-07-15T02:26:12Z; ultimo fichero data/WAL 02:26:16Z.
  No se arranco, reinicio ni modifico. El system identifier coincide con el clon
  mindbliss-local-recovery-20261022, demostrando la filiacion de ese clon, NO RDS.
- El archivo del 22 de octubre es una exportacion de ese origen historico.
  En el candidato PG18: 121066 personas, 121013 afiliados, ultima persona creada
  2026-06-19T00:39:07.417Z, ultima actualizada 2026-07-14T02:18:29.749911Z.
  Cero personas creadas/actualizadas desde agosto; cero Stripe events/intents,
  transacciones y movimientos de wallet. No es el estado RDS de septiembre.
- Catorce volumenes anonimos: 40-74 MB, metadata y data/WAL de junio/julio.
  Las tres fechas mas nuevas se investigaron en clones nuevos, sin red ni puertos,
  con origen montado readonly y recuperacion/escrituras solo sobre el clon.
- Volumen b9871b7b... del 20 de julio: DB vicionpower_test de unos 13.3 MB,
  una persona y un afiliado, auth.user vacia, cero Stripe y wallet movements.
- Volumenes 76b3e2d2... y 008167fc... del 21 de julio: bases postgres/t vacias,
  sin tablas de negocio. Los tres clones de auditoria quedaron detenidos;
  sus volumenes se conservaron y NO son fuentes independientes mas recientes.
- mindbliss-qa-postgres-1: dos personas sinteticas del 24 de octubre, cero afiliados.
- Contenedores app-platform staging/production: dos personas y cero afiliados,
  Stripe events y movimientos en cada uno. Son fixtures del script
  deploy/digitalocean/test-local.mjs, no despliegues ni backups reales de RDS.
- Se reviso el inventario de 88 imagenes: las imagenes PostgreSQL, Timescale,
  Supabase y backup son runtimes/herramientas; las rds-*-test son pruebas.
  No se identifico una imagen de recuperacion con datos reales de septiembre.

El backup db-audit-20261025 declara como origen el candidato PG18 recien creado,
no una descarga RDS nueva. Su fecha de exportacion no rejuvenece los datos.
Los artefactos detallados de esta auditoria son privados y no contienen una
copia recuperada de septiembre. Los SQL Server .bak no fueron usados como origen.

Se amplio la enumeracion a archivos accesibles de D: y del perfil local, pero
hubo directorios protegidos con acceso denegado. No equivale a una inspeccion
forense de sectores eliminados o a demostrar que no exista otra copia fuera de
las ubicaciones accesibles. La evidencia aportada finalmente por el usuario
confirma que la fuente reciente existio en RDS, pero no esta en los volumenes
Docker locales actuales. Detener nuevas importaciones hasta recuperar esa fuente.

## Integridad de la copia historica

La carga historica SI termino: las 61 tablas, posiciones completas del arbol,
usuarios, paquetes, wallets y 37 secuencias coinciden con el candidato Docker.
No hay indices/constraints invalidos. Ver IMPORT-20261025.md. Esta comprobacion
solo certifica igualdad con el origen historico, no vigencia para produccion.
