# Arbol, posiciones y lectura visual

Fecha: 2026-10-23, America/Bogota. Rama en los tres repositorios: `feature/tree-integrity-ux-20261023`.

## Hallazgos corregidos

1. Salud de la red y el explorador elegian distinta raiz cuando existia el afiliado de empresa con `legacy_id_vicionario=1` y la configuracion apuntaba a otro ID. La prueba nueva reprodujo 20/80 miembros en Salud frente a 2/1 en el explorador, con datos sinteticos. `BuildNetworkMetrics` ahora aplica la misma prioridad: empresa legacy, raiz configurada y fallback estructural. Una raiz eliminada/bloqueada no se reemplaza por sus hijos para calcular estas piernas. No cambia enlaces ni saldos.
2. El admin podia marcar una rama como expandida tras un fetch fallido y dibujar dos lugares disponibles falsos. Solo se abren ramas con respuesta cacheada correctamente, se conservan los errores y se pueden reintentar. Recargar invalida la generacion anterior tambien durante los lotes y su estado de carga.
3. El cliente no distinguia un hijo ausente de un hijo no incluido por profundidad/limite. La consulta incorpora un conteo indexado de hijos por nodo; el BFF publica `hasChildren` y `childrenComplete`. La UI solo muestra "Disponible" cuando la cobertura de ese padre esta confirmada. En otro caso muestra "Sin cargar". No agrega otra llamada HTTP ni expone PV de terceros.
4. Un 401/403 al actualizar podia conservar el arbol privado anterior sin advertencia. Ahora se descartan arbol, resumen y referido. Ante fallos temporales se conserva la ultima lectura con advertencia y reintento, no como una lectura nueva exitosa.
5. El conteo recursivo del cliente podia desbordar la pila ante ciclos o redes profundas. Se usa recorrido iterativo, sin reasignar lados. Se detectan slots duplicados y las vistas cortan ciclos. La CTE del miembro tampoco vuelve a incluir su propia raiz como descendiente.
6. El admin contaba la raiz como nivel 1 y el cliente como nivel 0. Ambos controles usan ahora generaciones descendientes desde la raiz visual, nivel 0. La profundidad global guardada de cada afiliado no cambia.
7. La expansion del mapa admin cambiaba la seleccion/raiz y el control interior heredaba la accion de teclado del contenedor. Seleccionar y expandir ahora son botones hermanos; abrir una rama no cambia la raiz visual. Existe retorno al inicio despues de enfocar una rama.
8. Los nodos tenian texto de 7-11 px y controles pequenos; se unifican las dimensiones del nodo (176x308), se mejoran etiquetas y objetivos tactiles, se agrupan comandos avanzados y se centra la raiz al abrir o redimensionar la vista. Se mantiene el negro/amarillo y los estados semanticos.

Los nodos bloqueados conservan ID, padre, L/R y descendientes. Sus datos personales siguen enmascarados. Admin y cliente tienen permisos distintos: el admin puede auditar PV/rango; el cliente no recibe volumen de terceros. Esa diferencia de contenido no modifica las posiciones.

## Auditoria de datos reales locales

Ejecutado nuevamente `_meta/ops/20261023_tree_placement_audit.sql` sobre `mindbliss-local-recovery-20261022`, DB `vicionpower`, mediante socket `/tmp`. Transaccion `REPEATABLE READ READ ONLY`, timeout 45 s. Solo se exportaron agregados.

| Medida | Resultado |
| --- | ---: |
| Afiliados / raices | 121013 / 21016 |
| Profundidad maxima | 364 |
| Slots padre/lado duplicados | 0 |
| Padres faltantes | 0 |
| Desajustes de path/depth | 0 |
| Closure inmediata faltante self / padre | 0 / 0 |
| Alcanzables desde raices | 121013 |
| Inalcanzables / limite de 1024 alcanzado | 0 / 0 |
| Sponsor fuera de ascendencia binaria | 26040 |
| Intents Stripe presentes | 0 |

Las 26040 discrepancias de patrocinador requieren validacion comercial de la migracion; no autorizan cambiar el padre. No se fusionaron las 21016 raices. La copia es historica: sin pagos Stripe no permite certificar usuarios nuevos, PV exclusivo de Mindbliss ni volumenes/comisiones actuales. No se cambiaron formulas de pagos, reserva, cargos, comisiones ni reparto a empresa.

## Pruebas

- Regresion de raiz: fallo reproducido antes del cambio; ambos casos pasan despues (configuracion desactualizada y raiz no disponible).
- Linux/Docker: `go test -race -count=1 -run 'Test(NetworkMetricsRootMatchesExplorer|BuildNetworkMetrics|PlacementSafety|AdminTree|Spillover)' -timeout=8m ./internal/payments`: aprobado. Incluye colocacion concurrente, lados explicitos y conservacion bajo bloqueados. No sustituye la bateria completa ni una prueba de 1100 usuarios.
- `go vet ./internal/payments`: aprobado.
- Cliente: 138 pruebas aprobadas, incluidas ocho nuevas de cobertura parcial, ciclo, cadena de 5000 nodos, duplicados, lados y fallos de autorizacion/actualizacion. Admin: 63 pruebas aprobadas.
- `node scripts/test-member-tree-query.mjs --qa-docker` en el repo cliente: ejecuta las consultas SQL reales extraidas mediante AST sobre `mindbliss-qa-postgres-1/mindbliss_qa`. Valida que un nodo L bloqueado conserva hijo R y que una respuesta limitada se marca incompleta. Los datos sinteticos se revierten con ROLLBACK.
- Compilaciones Next y typecheck aprobados. Lint sin errores; permanecen las 11 advertencias previas del admin y el aviso de Next sobre React 18.
- Navegador con fixtures: padres/lados de 101, 102(L), 103(R), 104(R bajo 102) iguales en ambas vistas. Rama fallida no produce slots disponibles; expandir con Enter conserva raiz; no hay botones anidados. Vista parcial muestra "Sin cargar" en el lado omitido.
- Movil 390x844: raiz completa dentro del lienzo, pagina sin desbordamiento horizontal, nodos de 308 px de alto sin contenido recortado. Escritorio revisado con ambas vistas. No se usaron credenciales ni se enviaron OTP/pagos.
- Docker final: imagenes admin, cliente y payments reconstruidas y levantadas; typecheck del cliente y pruebas 138/63 aprobadas dentro de Linux. Smoke del conjunto: 24 comprobaciones HTTP aprobadas, incluida la proteccion de las rutas privadas.

## Entrega y limites

No hay migraciones nuevas ni modificaciones de posiciones reales. La lectura anonima de las rutas sigue bloqueada; el visor sintetico vive fuera de las rutas Next y solo escucha en loopback. Cambios locales en ramas feature, sin push/merge/despliegue publico.

Para produccion sigue siendo necesario conciliar la DB vigente con Stripe y verificar las discrepancias legacy antes de aprobar cualquier recolocacion o recalculo financiero.
