# Auditoría de binario, PV y candados — 5 de noviembre de 2026

## Alcance y resultado

Los enlaces técnicos de este informe fijan el snapshot productivo
`46c42a9ec9a328d6373f17b3d68b680b0dcf53a3`, cuyo código financiero citado es
idéntico al revisado. Añadir este informe a `main` no incorpora el código,
las migraciones ni la infraestructura de ese snapshot. La receta de identidad
y su ensayo se guardan por separado; no hay migración automática ni despliegue.

Este documento describe el comportamiento observado en el código local y los agregados de producción comunicados por el operador principal el **5 de noviembre de 2026**. No es una autorización para recalcular ni pagar compensaciones. La auditoría no ejecutó cierres, activaciones, reasignaciones de posiciones, cambios de rangos, emisiones de bonos, ajustes de saldos ni llamadas a proveedores. El autor de este documento no consultó la base productiva: los agregados de esa sección provienen de la comprobación de sólo lectura realizada por el operador principal.

Hay dos circuitos que no deben confundirse:

- El CSV Stripe aprobado alimenta la evidencia e informes de ventas; por sí solo no activa paquetes, principal, PV ni comisiones operativas.
- El motor acotado NOWPayments procesa únicamente compras operativas activadas con comprobantes y manifiesto consistentes. Utiliza PV y obligaciones propios, separados de los acumuladores globales heredados.

Se conservan las posiciones y los rangos históricos. Eso no convierte ventas históricas excluidas, hitos de rango ni saldos recuperados en nuevas fuentes de compensación. Se encontró además un defecto condicional de regalías para patrocinadores situados fuera de la proyección física de diez niveles; **no se corrigió ni se recalculó nada durante esta revisión**.

## Evidencia agregada de producción

La lectura corresponde al 5 de noviembre; no se dispone aquí de una hora exacta ni de una certificación de saldos del proveedor.

| Fuente o estado | Cantidad | Importe o volumen observado |
| --- | ---: | ---: |
| Ventas del CSV Stripe activo | 733 | USD 87.668,00 |
| CSV con estado pagado | 545 | USD 64.640,00 |
| CSV en revisión | 188 | USD 23.028,00 |
| NOWPayments activadas | 1 | USD 50,00 brutos; USD 49,50 netos; 50 PV |
| NOWPayments pendientes de pago | 40 | Sin PV operativo activado |
| NOWPayments bloqueadas por seguridad | 7 | Sin PV operativo activado |
| NOWPayments en revisión de riesgo | 1 | Sin PV operativo activado |
| Obligaciones ROI NOW | 5 | USD 0,17, pendientes; ninguna disponible |
| Obligaciones de referido, regalía y binario NOW | 0 | Ninguna acreditación de estos conceptos |

El total de ventas reportadas CSV más la compra NOW activada es **USD 87.718,00**; no representa dinero líquido ni principal operativo atribuible a las 733 filas del CSV. La separación pagado/revisión del CSV debe seguir visible.

En la raíz PARTNER se observaron **50 PV NOW en la rama izquierda y 0 en la derecha** mediante la consulta de subárbol. Esa consulta agregada no sustituye el recorrido pagable limitado a diez niveles del motor. Las columnas globales heredadas de PV seguían en cero. Con una única compra NOW y sin volumen derecho no se forma un bloque binario, aun antes de comprobar los demás requisitos.

La configuración activa informada fue `v2-baseline`: QL=1, QR=1, bloque=500 PV, unidad=USD 10, profundidad=10, `treasury_alpha=0.45`, multiplicador vitalicio=2, bloqueo CD=365 días y `ranks_enabled=false`. También se observó el campo heredado `settlement_available_lag='1 mon 1 day'`; no es la fórmula utilizada por las obligaciones NOW, como se explica más adelante.

Otra consulta de sólo lectura confirmó que la restricción
`nowpayments_commission_calendar_month_v1` existe y está validada. Se observaron
cero incumplimientos del mes calendario y cero diferencias entre el vencimiento
ROI y el CD. La única inversión operativa conservaba principal USD 50,00,
íntegramente bloqueado, y su vencimiento era exactamente inicio más 365 días.
No se cambiaron parámetros ni se adelantó la disponibilidad de ningún importe.

En la última comprobación comunicada por el operador, `engine_last_run` era reciente, el corte ROI era `2026-11-05` y `maxLagDays=0`: no se observó atraso actual del ROI. Es una instantánea puntual, no una garantía de ejecución futura.

## Fuentes admitidas y procedencia

### CSV Stripe: informe, no autorización financiera

La migración [`87_admin_sales_reporting.sql`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/_meta/migration/87_admin_sales_reporting.sql) mantiene las filas importadas como evidencia, con lote activo revisado, identificadores únicos y selección de membresías. Fija `provider_verified=false`, `commission_eligible=false` y `activation_status='not_inferred_from_import'`. Incluso una fila con estado pagado no se interpreta como autorización para generar una nueva inversión o comisión.

[`member_recovery.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/member_recovery.go) consulta esta evidencia en una instantánea de sólo lectura, exige correspondencia de identidad y no transforma los importes desconocidos en balances disponibles. [`stripe_recovery_read.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/stripe_recovery_read.go) conserva la distinción entre ventas verificadas como evidencia, obligaciones desconocidas e hitos históricos de rango. Las fuentes canónicas antiguas retenidas para auditoría no son ventas adicionales del lote activo.

El candado [`financialguard/guard.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/shared/financialguard/guard.go) bloquea las mutaciones financieras globales heredadas cuando existe `payments.stripe_sale`; el motor NOW dispone de un escritor y una procedencia acotados, no de permiso para ejecutar los cierres globales.

### NOWPayments: manifiesto operativo cerrado

[`nowengine/service.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/service.go), especialmente `validateReady` y `load`, valida la configuración aprobada y carga únicamente órdenes `activated` con intento productivo, recibo terminado verificado, captura segura, paquete propio NOW, CD, estado de tope, entrada neta y fuente PV concordantes. Exige la política `catalog_includes_provider_1pct_v1`, referencias de factura/pago y las igualdades de precio, principal, neto y PV. Un riesgo detectado en una fuente ya activada congela la ejecución acotada; no se compensa silenciosamente con datos heredados.

Las facturas abiertas, pagos aún no terminados, eventos no verificados, pagos múltiples, cancelaciones con revisión y órdenes bloqueadas no se vuelven PV por aparecer en el historial. La activación se realiza transaccionalmente en [`nowpayments_operational_store.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/nowpayments_operational_store.go), sin volver a comprar al proveedor.

El manifiesto admite como máximo 5.000 órdenes operativas. Es un límite explícito de capacidad funcional, no una prueba de latencia ni un objetivo de rendimiento garantizado.

## Fórmulas vigentes

Las comprobaciones exactas de configuración y las funciones puras están en [`nowengine/policy.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/policy.go). Los cálculos monetarios usan decimales y redondeo hacia abajo a centavos donde corresponde.

### Precio, neto, principal y PV

Para un catálogo de **USD 100 y 100 PV**:

- El comprador paga USD 100; no se añade un recargo del 1 %.
- La base monetaria de compensación es `neto = 100 × 0,99 = USD 99`.
- El principal del CD se conserva en USD 100.
- La fuente de puntos conserva **100 PV**, no 99 PV.

El 1 % es la política interna de cálculo aprobada; esta igualdad no certifica las comisiones o la liquidación final realmente cobradas por el proveedor.

### Patrocinio, referido y regalía

El patrocinador comercial (`sponsor`) y el padre físico del árbol (`parent`) son relaciones diferentes. El referido y la regalía siguen el patrocinio; la propagación binaria sigue el padre y la posición física L/R.

- Referido ordinario: `venta_neta × 5 %`; USD 4,95 para el ejemplo.
- Referido de fundador: `venta_neta × 10 %`; USD 9,90 para el ejemplo.
- Regalía de segunda generación de patrocinio: `venta_neta × 5 %`; USD 4,95 para el ejemplo.

El referido exige patrocinador activo no raíz, una membresía NOW propia elegible y la calificación QL/QR. La regalía exige segundo patrocinador activo no raíz y membresía NOW propia elegible; el código no le exige la misma condición QL/QR del referido. La raíz física, cuyo `parent` es nulo, queda excluida expresamente de estos dos flujos. No se debe asumir que PARTNER cobra estos conceptos por ser raíz.

QL=1 y QR=1 significan **dos compradores directos distintos**, patrocinados por el beneficiario, activos y con membresía NOW elegible, uno en cada rama física. Varias compras de la misma persona no se convierten en varios directos. Un comprador exclusivamente CSV no satisface el requisito de compra NOW. Para referido/binario, el agotamiento del tope del paquete no equivale por sí mismo a perder la membresía; la mejora de ROI aplica requisitos adicionales de CD vigente, tope y nivel.

### Binario y carry

[`nowengine/accrual.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/accrual.go), función `binary`, recorre hasta **diez ascendientes físicos** de cada venta NOW activada antes del fin del período. En cada salto, la posición del hijo decide si el PV se suma a la izquierda o a la derecha del padre.

```text
PV_emparejados = min(PV_izquierdo_acumulado, PV_derecho_acumulado)
bloques_totales = floor(PV_emparejados / 500)
bloques_nuevos = bloques_totales - claimed_blocks
binario_ordinario = floor_centavos(bloques_nuevos × USD 10 × 0,99)
```

Un bloque ordinario devenga nominalmente **USD 9,90 netos**, antes de topes y financiación. Para fundador, la unidad es `500 × 10 % × 0,99 = USD 49,50` por bloque, no USD 10 más un bono adicional. El beneficiario debe estar activo, tener paquete NOW propio elegible y cumplir QL/QR.

Los volúmenes se reconstruyen acumulativamente desde las fuentes NOW y `claimed_blocks` evita volver a devengar bloques ya tratados. El PV de la rama fuerte no emparejado queda implícitamente pendiente; este circuito no ejecuta la expiración de carry del motor global heredado. Los bloques excluidos por tope sí avanzan `claimed_blocks`: **una exclusión por tope es definitiva**, no carry monetario recuperable.

### Topes y financiación

Se aplican capas distintas que no deben presentarse como un único saldo:

1. **Tope denominado diario:** `3 × bonus_amount_usd` del rango conservado. La implementación actual aplica ese valor una vez por cierre semanal binario. El nombre `daily_cap_factor` no implica que el código multiplique el tope por siete ni que haga siete cierres diarios. Esta discrepancia de denominación requiere decisión explícita antes de alterar la regla.
2. **Tope vitalicio del paquete:** `2 × principal_bruto`, compartido por ROI y binario. Referido y regalía no consumen ese tope en el circuito actual; sí entran en el presupuesto de financiación. El binario selecciona el paquete NOW elegible de mayor identificador, no la suma de los paquetes ni necesariamente el de mayor precio. Cada compra conserva su propio CD/ROI, pero no debe prometerse suma de topes binarios por tener varias compras.
3. **Presupuesto y theta:** para el cierre, con `I` entradas netas NOW acumuladas hasta su fin, `R` ROI ya acreditado y `C` otros créditos internos previos:

```text
B = max(0, floor_centavos(0,45 × I) - R - C)
P = suma de obligaciones no ROI pendientes, sin importes ya acreditados/excluidos
theta = clamp(B / P, 0, 1), truncado a seis decimales; si P = 0, theta = 1
crédito_i = floor_centavos(pendiente_i × theta), sujeto a tope de paquete si aplica
```

La parte retenida por falta de presupuesto permanece como obligación para presupuestos futuros. Es diferente de `cap_excluded_usd`, que no se vuelve a intentar. El código comprueba que los créditos de cierre no superen su presupuesto calculado.

`paid_usd` describe **acreditación interna al ledger**, no pago bancario, retiro ejecutado ni liquidación externa de NOWPayments. Esta fórmula no prueba solvencia, cobertura del principal, reservas efectivas, disponibilidad de caja ni rentabilidad garantizada.

### ROI y períodos

El ROI usa el principal bruto, no la base del 99 %. El cálculo base es anual 25 %; el tramo calificado utiliza 30–50 % según el nivel y las condiciones del CD. Se acumulan los numeradores de días/tasas y se divide entre 365 antes del redondeo acumulado, evitando descartar cada día sus fracciones. Por ejemplo, USD 100 al 25 % durante 365 días produce una obligación aritmética de USD 25 antes del tope y los demás controles; no es una garantía de rendimiento ni de pago.

Los cierres comerciales son semanales: lunes 00:00 en `America/Bogota` hasta el lunes siguiente, elegibles dos horas después del fin. El ejecutor usa hora de PostgreSQL, transacción serializable y presupuesto de 20 segundos. Recupera hasta cuatro días de ROI por pasada y sólo cierra semanas cuando el ROI está al día, con un máximo de ocho períodos por pasada y reserva temporal para confirmar la transacción. Las frecuencias de despertado no demuestran por sí solas que el motor esté al día.

## Disponibilidad: un mes calendario y 365 días

Para referido, regalía y binario NOW, `createObligation` fija exactamente:

```sql
((now() AT TIME ZONE 'America/Bogota') + interval '1 month')
    AT TIME ZONE 'America/Bogota'
```

Se cuenta **un mes calendario desde la creación de la obligación**, no treinta días, ni el último día del mes de venta. Una recuperación tardía de cierres no retrocede la fecha del bloqueo. La restricción de [`82_nowpayments_calendar_maturity.sql`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/_meta/migration/82_nowpayments_calendar_maturity.sql) exige esa igualdad.

PostgreSQL conserva la hora civil de Bogotá y ajusta los fines de mes: 31 de enero de año no bisiesto pasa a 28 de febrero; en año bisiesto, a 29 de febrero. 30 de abril pasa a 30 de mayo, no al último día de mayo.

El CD conserva principal y vencimiento a **365 días exactos**. El ROI queda sujeto al vencimiento exacto de su CD, no a la retención mensual de comisiones. Cumplir el año no ejecuta automáticamente un retiro ni abona de nuevo el principal. El modelo de lectura acotado mantiene `withdrawals_enabled=false`.

El ledger heredado guarda una proyección `DATE`; [`now_scoped_posting.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/bonusengine/now_scoped_posting.go) la redondea conservadoramente al siguiente día UTC cuando es necesario para no anticipar el vencimiento. La autoridad NOW sigue siendo el `available_at` exacto de la obligación y sus controles de beneficiario, moneda, riesgo y seguridad, no esa fecha proyectada. Los importes enviados a retiro/retirement o redirigidos a otro beneficiario tampoco son saldo líquido del afiliado original.

El parámetro heredado `settlement_available_lag='1 mon 1 day'` **no es una compensación de zona horaria**. La función global `mlm.fn_bonus_available_at` de [`schema_payouts_v1.3.sql`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/_meta/schema_payouts_v1.3.sql) parte del último día del mes y aplica ese intervalo; tiene otra semántica. El motor acotado NOW no llama esa función ni utiliza ese campo. Modificarlo globalmente no es una reparación de la disponibilidad NOW.

## Candados e idempotencia

| Operación | Protección en la ruta normal |
| --- | --- |
| Activación de compra | Bloqueo del intento y de la orden `FOR UPDATE`; transición sólo desde `awaiting_payment`; comprobaciones de identidad, bloqueo, captura y recibo; paquete/CD/entrada/PV/estado en la misma transacción. |
| Nueva posición | Candado asesor por patrocinador, unicidad padre/posición, reintentos de conflicto acotados y bloqueo de ascendientes. Un afiliado ya posicionado no se mueve. |
| Ejecutor NOW | `SERIALIZABLE`, `pg_try_advisory_xact_lock` global del motor acotado y lectura de órdenes fuente `FOR SHARE`. Una segunda ejecución concurrente no abre otro cierre por ese camino. |
| Acumulación ROI | Estado de corte por compra bloqueado `FOR UPDATE`, referencias externas únicas y actualización transaccional con el ledger. |
| Período semanal | Par inicio/fin único, fila bloqueada y retorno sin efecto si ya está cerrada. |
| Binario | Fila única por afiliado y contador `claimed_blocks` bloqueado mediante UPSERT; orden determinista de afiliados. |
| Obligación y acreditación | Referencia externa única de obligación, bloqueo de obligación antes de acreditar, combinación obligación/cuota única y referencias contables únicas. |
| Tope de paquete | `package_cap_state FOR UPDATE`; crédito, contador, exclusión y consumo de tope se confirman juntos. |
| Trabajo durable de activación | `FOR UPDATE SKIP LOCKED`, lease de 60 segundos, token de ejecución y actualización condicional; no supone crear otro cobro al proveedor. |

Referencias principales: [`nowpayments_operational_store.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/nowpayments_operational_store.go), [`nowpayments_operational_jobs.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/nowpayments_operational_jobs.go), [`activation.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/activation.go), [`nowengine/service.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/service.go), [`nowengine/accrual.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/accrual.go), [`now_scoped_posting.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/bonusengine/now_scoped_posting.go) y [`80_nowpayments_scoped_engine.sql`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/_meta/migration/80_nowpayments_scoped_engine.sql).

Estos candados protegen las rutas de aplicación revisadas. No constituyen una demostración de aislamiento frente a SQL arbitrario con credenciales de escritura comprometidas. Los permisos y restricciones actuales no hacen todas las relaciones de procedencia, igualdad del contador con el ledger o consistencia completa del árbol imposibles de violar por SQL directo. No se cambiaron roles ni esquema para este informe.

## Posiciones, rangos y presentación

Se preservan el rango actual, los hitos históricos y la geometría ya existente. `ranks_enabled=false` deshabilita el flujo de nuevos rangos en este motor; **el rango conservado sigue influyendo en el tope binario** mediante `bonus_amount_usd`.

El alta NOW llama al colocador con `globalEnrollment=false`: no incrementa los contadores globales de PV ni emite eventos globales de enrolamiento. Con rama explícita, el colocador desciende por ese mismo lado; no es una búsqueda por amplitud. Sin preferencia, compara PV global heredado y después cantidades de nodos, con desempate izquierdo. Si esos PV están en cero mientras existen fuentes NOW, la decisión puede acabar dependiendo de cantidades de personas y no del volumen económico NOW.

El administrador todavía lee `left_pv_current/right_pv_current` en [`admin_tree.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/admin_tree.go). La revisión del portal confirmó que usa `current_rank_id` y `mlm.v_rank_progress`, no una proyección directa de las fuentes PV NOW. Por tanto, ver cero en esos acumuladores de pantalla junto con 50 PV en el sidecar NOW es una **diferencia de modelo**, no prueba de pérdida de la compra. Tampoco debe resolverse inflando el histórico o inventando PV a partir del total del CSV.

## Hallazgo pendiente: regalía omitida por proyección física

**Defecto confirmado en una fixture local; sin corrección aplicada.** `load` en [`nowengine/service.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/service.go) carga ancestros físicos con distancia menor o igual a diez. `referrals` en [`nowengine/accrual.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/nowengine/accrual.go) abandona toda la venta cuando no encuentra al patrocinador directo dentro de ese universo, antes de evaluar la segunda generación.

Caso reproducido:

1. Un comprador está a más de diez niveles físicos de su patrocinador por derrame.
2. Ese patrocinador no tiene una compra NOW propia, por lo que tampoco se carga como comprador operativo.
3. El segundo patrocinador sí tiene una membresía NOW elegible y está presente en el universo.
4. Con el universo completo corresponde evaluar la regalía de segunda generación; con la proyección física actual se omite. Si el patrocinador intermedio adquiere una membresía NOW, la regalía vuelve a aparecer en la fixture.

Resultado para una venta de USD 100: universo completo, regalía USD 4,95; universo limitado, ninguna; control con patrocinador intermedio presente, regalía USD 4,95. Se ejecutó la función real con un `pgx.Tx` falso que sólo captura inserciones permitidas; hubo **cero conexiones reales a bases o proveedores**.

No es una consecuencia necesaria del límite binario de diez niveles: la regalía tiene una regla de dos generaciones de patrocinio diferente. No se afirma que el caso se haya producido en la única venta NOW activa de la instantánea. Cualquier reparación requiere una decisión y pruebas de procedencia antes de reconstruir obligaciones; no debe ejecutar de forma automática cierres o pagos históricos.

## Verificación y límites de las pruebas

Se ejecutaron pruebas locales con fuentes montadas de sólo lectura, contenedor sin red y `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`:

- Suite pura de `internal/nowengine` con `-race -short -count=1`, junto con la fixture efímera del defecto de proyección: nueve pruebas aprobadas. La fixture no se incorporó al código de aplicación.
- Pruebas `TestNOWROIAvailableDateNeverPrecedesExact365DayMaturity` y `TestNOWCommissionAvailableDateNeverPrecedesExactCalendarMaturity` con `-race`: aprobadas; cubren también las proyecciones de fecha conservadoras.
- Parser de importación CSV: `node --test app/scripts/sales-csv-import.test.mjs`, 18 pruebas aprobadas en la revisión paralela.

Comandos seguros para repetir las pruebas existentes, sin conectar PostgreSQL ni proveedores:

```powershell
docker run --rm --network none `
  --mount type=bind,source=D:/vicionpower/backend/vp-engine,target=/workspace/vp-engine,readonly `
  --env GOPROXY=off --env GOSUMDB=off --env GOTOOLCHAIN=local `
  --entrypoint go mindbliss-qa-go-tests:latest `
  test -race -short -count=1 ./internal/nowengine -v

docker run --rm --network none `
  --mount type=bind,source=D:/vicionpower/backend/vp-engine,target=/workspace/vp-engine,readonly `
  --env GOPROXY=off --env GOSUMDB=off --env GOTOOLCHAIN=local `
  --entrypoint go mindbliss-qa-go-tests:latest `
  test -race -short -count=1 ./internal/bonusengine `
  -run '^TestNOW(ROI|Commission)AvailableDate' -v
```

La imagen QA es una herramienta local ya existente, no una imagen productiva ni una versión reproducible fijada por digest en este informe. Debe contener las dependencias previamente disponibles para que los comandos funcionen sin red. La reproducción del defecto usó además un overlay efímero externo al repositorio; no está incluida en los comandos de pruebas existentes anteriores.

Las fixtures PostgreSQL de fin de mes, cambio de año, año bisiesto, sesión UTC/otra zona y rechazo de diferencias de microsegundos se **leyeron** en [`nowengine_scoped_integration_test.go`](https://github.com/Alain-Colombia-Arbitrage-Mev/mindblisspower-back/blob/46c42a9ec9a328d6373f17b3d68b680b0dcf53a3/vp-engine/internal/payments/nowengine_scoped_integration_test.go), pero **no se ejecutaron** contra PostgreSQL en esta auditoría. Las pruebas puras y `-race` no sustituyen esa verificación, pruebas reales de concurrencia SQL, reconciliación de caja ni validación de continuidad operativa.

## Acciones que requieren autorización separada

Este informe no implementa las siguientes decisiones: reparar la proyección de regalías; reconciliar la presentación de PV NOW con el árbol del portal; redefinir el tope denominado diario; convertir ventas CSV en fuentes operativas; ampliar capacidad; endurecer la integridad de procedencia por SQL; ni recuperar o pagar obligaciones históricas. Ninguna de ellas debe alterar posiciones, rangos conservados o reglas económicas como efecto secundario de una mejora visual o de caché.
