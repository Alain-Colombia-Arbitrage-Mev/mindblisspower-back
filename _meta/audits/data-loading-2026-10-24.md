# Auditoria De Lecturas Frontend/API/DB - 2026-10-24

Rama: `feature/data-load-diagnostics-20261024`.

## Diagnostico Reproducible

Ejecutar desde backend:

```powershell
node deploy/docker-qa/diagnose-data.mjs --qa-docker
```

El script solo acepta los contenedores conocidos del proyecto Compose `mindbliss-qa`, la base sintetica `mindbliss_qa` y la credencial sintetica de ese entorno. No admite URL, base ni credenciales de produccion como argumentos. Los valores de configuracion del frontend se informan solo como booleanos.

Hace GET a 15 endpoints de lectura de vp-payments: administradores, usuarios, resumen, pagos, finanzas, solvencia, reporte de ventas, carritos, raices del arbol, salud de red, sostenibilidad, resumen del centro de mando, alertas, blacklist y tickets. Registra estados HTTP, tiempos y tamanos de colecciones, nunca las filas. Consulta los conteos SQL dentro de `BEGIN READ ONLY` y no contiene DDL ni escritura SQL.

Resultado comprobado: los 15 endpoints respondieron HTTP 200 y JSON valido; `mindbliss_qa` contiene 2 personas, 0 afiliados y 0 intenciones de compra. Es un entorno de prueba casi vacio, no la base historica recuperada. El archivo agregado se genera en `D:/vicionpower/reportes/data-diagnostics-20261024.json`.

## Frontera De La Verificacion

- API Go -> PostgreSQL QA: verificada para las lecturas indicadas, usando exclusivamente el acceso sintetico ya configurado en QA.
- Frontend -> BFF con sesion Cognito real: pendiente. Los contenedores QA tienen Cognito vacio y demo deshabilitado; el informe lo declara mediante `authenticatedBffVerified: false`.
- Puerto 64421: harness visual sintetico, sin conexion a PostgreSQL. No sirve como evidencia de datos reales.
- No se modifico ni conecto a escritura el contenedor de recuperacion historica. No se restauraron respaldos encima de bases existentes.
- No hubo OTP, emails, operaciones Stripe, pago de retiros, baneos ni cambios de posiciones.

## Correccion Complementaria En Admin

La rama homonima de `mindblisspower-admin` corrige lecturas silenciosas en Administradores, Usuarios, retiros, Finanzas y Centro de Mando. El BFF de salud ya no convierte fallos upstream en HTTP 200. Incluye validacion de respuestas, cancelacion y timeout, mensajes sin detalles privados y reintento manual. No se cambio codigo Go, esquemas, saldos ni reglas del arbol.

Validaciones: 90 pruebas admin aprobadas en Docker, lint sin errores, build optimizado correcto y contenedor admin saludable. El smoke del stack aprobo 24 comprobaciones HTTP. El diagnostico aprobo las 15 lecturas citadas. La reconstruccion final se hizo sin recrear PostgreSQL ni Redis.

Adicionalmente, los validadores de lectura del frontend aceptaron las respuestas reales QA de administradores, usuarios, resumen, finanzas, solvencia y retiros (6 contratos). Esto verifica compatibilidad de datos, no sustituye la prueba pendiente de una sesion Cognito real.

## Siguiente Paso Para Integracion Real

Preparar una copia aislada de trabajo del respaldo, validar esquema/datos y configurar autenticacion real sin publicar secretos. Luego verificar las pantallas con una sesion autorizada contra esa copia. No activar modo demo ni deshabilitar identidad para forzar que aparezcan datos. No se ha desplegado este cambio a produccion.
