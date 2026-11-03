# Alcance de ventas y valores: conciliación del 3 de noviembre de 2026

## Decisión del propietario

La instrucción más reciente del propietario es conservar los rangos Y todas las
posiciones, padres, patrocinadores y ramas existentes. Sustituye la propuesta
anterior de separar/recalcular la calificación histórica. No se alteran
`current_rank_id`, `rank_points_baseline`, logros ni topes asociados al rango.

La fuente vigente de ventas es el CSV Stripe revisado, más las compras NOWPayments
completadas y verificadas. No incluir facturas abiertas ni otras ventas antiguas.

Esta decisión no convierte un importe vendido en dinero disponible. Deben
conservarse los estados de revisión, disputa, reembolso y bloqueo de capital.

## Fuente comprobada, sin reimportar ni escribir en producción

Archivo de origen: `unified_payments(1) - Stripe Dashboard.csv`.

SHA-256:
`e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20`.

| Concepto | Pagos | Bruto USD |
| --- | ---: | ---: |
| Archivo completo | 737 | 88.588,00 |
| Productos sin atribución excluidos por el propietario | 4 | 920,00 |
| Membresías Stripe incluidas | 733 | 87.668,00 |
| Stripe: Paid, incluidos dos pagos disputados | 545 | 64.640,00 |
| Stripe: En Revisión | 188 | 23.028,00 |
| NOWPayments completada al comprobar la base | 1 | 50,00 |
| Total vigente comprobado | 734 | 87.718,00 |

Los dos pagos disputados suman USD 202,00; permanecen separados del dinero
disponible. El resumen del CSV difiere en USD 2,40 respecto a su detalle en
revisión: se conserva el detalle sin ajustar cifras artificialmente.

El catálogo corroborado suma USD 86.800 de precio base y 86.800 PV para las
733 filas Stripe. No es el bruto de USD 87.668: el bruto legado incluye un
recargo del 1 %. Esos PV son evidencia de catálogo, no PV operativos ya emitidos.

La importación 87 es sólo de reporte: sus restricciones fijan
`provider_verified=false`, `commission_eligible=false` y
`activation_status='not_inferred_from_import'`. No ejecuta activaciones.

## Diferencias detectadas

- La evidencia Stripe canónica conserva 838 pagos por USD 101.808; 105 pagos
  por USD 14.140 están fuera del CSV vigente. Debe preservarse como auditoría,
  pero no volver a incorporarse al historial vigente del miembro.
- El informe administrativo ya utiliza `payments.v_admin_sales`: CSV activo
  revisado más NOWPayments con prueba de pago. El resumen del miembro todavía
  consultaba directamente toda la evidencia Stripe canónica.
- La declaración antigua de fondos de Stripe se refiere a los 838 pagos y a
  USD 13.000 reportados como entregados a la empresa. No es pago a afiliados ni
  puede repartirse proporcionalmente entre las nuevas 733 ventas.
- De las 733 ventas Stripe del reporte, 732 tienen propietario coincidente e
  identidad canónica verificada. Una por USD 101,00 no tiene propietario en el
  reporte y carece de identidad canónica verificada: permanece en el total
  administrativo, pero no se atribuye a un miembro ni se vincula automáticamente.

## Estado operativo observado, no un saldo reconstruido

Al revisar producción sólo había una membresía operativa, de NOWPayments,
con capital USD 50,00 y ROI acumulado USD 0,10. Había tres movimientos,
todos vinculados al motor NOWPayments. La importación Stripe no creó
membresías, inversiones, comisiones ni movimientos contables operativos.

El árbol conservaba 121.073 nodos. Sus PV actuales y de vida estaban en cero,
pero 9.977 nodos conservaban rango y una base histórica de calificación;
la suma de esas bases era 365.966.500 puntos. También había 28.155 hitos de
rango históricos, que no constituyen una deuda pagada ni una comisión nueva.

`current_rank_id` no es sólo presentación: el motor NOWPayments lo utiliza
para el tope binario. Además, el trigger de logros vuelve a seleccionar el
mayor rango de todo el historial. Borrar rangos o poner bases en cero de forma
aislada no es una reconstrucción correcta de la calificación.

## Corrección de lectura y límites de su alcance

La corrección del miembro debe:

1. Usar únicamente el lote Stripe vigente de las vistas aprobadas de reporte.
2. Exigir coincidencia tanto con el propietario de la fila de reporte como con
   la identidad canónica verificada; no deducir identidad por precio o nombre.
3. Mantener revisión, disputa y reembolso, sin promover elegibilidad financiera.
4. Fallar de forma cerrada si existe una instalación parcial de reportes,
   falta la fuente activa o el lote no está revisado. No volver silenciosamente
   a los 838 pagos antiguos.
5. Mantener compatibilidad canónica sólo en bases sin ningún objeto de la
   nueva instalación de reportes.
6. No cambiar geometría, rangos, principal, ROI, comisiones, roles ni permisos.

Los datos financieros desconocidos del resumen de recuperación siguen siendo
JSON `null`, no cero inventado ni saldo retirable. Los totales brutos de compras
del administrador conservan su contrato de reporte y sus estados; no se renombran
como saldo ni como comisión disponible.

## Operaciones fuera del alcance de esta corrección

No se recalculan rangos ni su calificación histórica: el propietario ha indicado
expresamente conservarlos. Tampoco se reproduce una reconstrucción financiera a
partir de una importación de reporte. Se mantienen estas protecciones:

- Preservar el rango histórico, su base de puntos y su efecto actual en el tope
  binario. No borrar rangos para ajustar una cifra de ventas.
- Definir elegibilidad por identidad, producto, pago, disputa y revisión; un
  estado `Paid` por sí solo no sustituye la conciliación ni elimina una disputa.
- Utilizar PV del catálogo verificado o del `operational_pv_source` NOWPayments,
  nunca bruto monetario ni 99 % del precio como sustituto de PV.
- No reproducir `tree_event`, logros, activaciones o bonos ya registrados.
- Mantener capital bloqueado un año y comisiones pendientes un mes calendario
  según las reglas autorizadas; no asumir que esos plazos resuelven retenciones
  del proveedor o estados bajo revisión.
- Comprobar que las consultas no modifican posiciones, rangos, movimientos,
  capital, comisiones ni la fuente activa.

La corrección de consultas no debe describirse como esa reconstrucción ni como
habilitación de retiros de los USD 87.718.

## Verificación de la corrección

- Go 1.26.10 con `-race` y PostgreSQL 17.11: 6 pruebas principales y 22 subcasos,
  sin fallos ni omisiones. Cubren el guard de fuente, reporte consolidado,
  aislamiento del miembro y ausencia de mutaciones.
- Worker core: 134 pruebas correctas; no se modifican las capacidades habilitadas,
  el proveedor de correo ni las credenciales.
- La consulta equivalente del historial se contrastó en producción mediante
  SELECT agregado: 732 ventas atribuibles por USD 87.567,00, más la venta de
  USD 101,00 conservada sin atribución en el total administrativo Stripe.
- Se tomaron huellas agregadas de geometría, rangos y evidencia canónica antes
  del despliegue para comprobar que no se alteran.
