# Diagnóstico de acceso por correo — 2026-10-30 (Bogotá)

## Causa y alcance comprobados

Una cuenta del árbol migrado no es una cuenta de acceso Better Auth. El plugin
tiene `disableSignUp: true`: solicitar un código de login para un correo sin
`auth.user` devuelve la respuesta genérica de privacidad, pero no envía correo.
No debe interpretarse ese HTTP 200 como confirmación de entrega.

Consulta productiva agregada en transacción READ ONLY, con límites de tiempo:

- 1 cuenta de acceso, verificada; 0 cuentas pendientes.
- 121.077 correos distintos no vacíos en `mlm.person`; 121.076 sin cuenta de acceso.
- 49 grupos de correo compartido por varias personas.
- 90 correos del legado no pasan una comprobación sintáctica básica. Esto no es
  una comprobación de existencia o entrega del buzón.

No se exportaron listas de personas/correos, hashes, valores de OTP ni sesiones.
No se crearon cuentas, no se cambió `email_verified` y no se asignaron identidades,
roles, posiciones o rangos. Migrar accesos pendientes es una operación separada
que requiere decisión explícita. Los correos compartidos o inválidos requieren
revisión; nunca deben vincular automáticamente personas por coincidencia de email.

## Cloudflare

El token local de envío está activo. OAuth confirma zona activa, Email Sending
habilitado y coincidencia de los seis registros DNS requeridos (MX, SPF, DKIM,
DMARC). Los portales conservan bindings y versiones productivas esperados. La
lista de zonas vacía con el token de email no equivale a una zona deshabilitada:
su visibilidad es distinta de la credencial OAuth de diagnóstico.

No hay supresiones para las dos direcciones de prueba autorizadas previamente.
La consulta de analítica agregada del 27 al 30 de octubre UTC devuelve un evento
`delivered` el 28 de octubre; no demuestra entrega de solicitudes que nunca
generaron email. No se consultaron cuerpos, asuntos, cabeceras ni códigos.

## Correcciones técnicas

- El presupuesto persistente distingue una carrera con reserva real (429 y
  deadline restante) de un fallo de almacenamiento (503 genérico). Nunca borra,
  reinicia ni reintenta reservas. Un error de transacción falla cerrado.
- El portal permite introducir un código posiblemente recibido tras timeout,
  error 5xx o acuse inválido. Mantiene el destinatario original, espera segura y
  recuperación manual, sin afirmar entrega ni reenviar automáticamente.
- El login explica de forma genérica el registro del nuevo acceso para usuarios
  antiguos. No consulta públicamente si una dirección existe ni concede acceso
  a la red por verificar únicamente el correo.

La infraestructura de correo no se altera para resolver la falta de cuentas.
No se eliminan supresiones ni se relajan límites, origen, sesiones o RBAC.
Finanzas, árbol/rangos y Chatwoot quedan fuera de esta publicación.

## Verificación y publicación

Backend Linux/Bun 1.4.4: 132 pruebas aprobadas, 14 dependientes de entorno omitidas,
0 fallos; typecheck, generación de toolchain y 24 sondas HTTP aisladas aprobados.
Sin red externa ni proveedores reales. La matriz de elegibilidad confirma envío
para cuentas existentes verificadas/no verificadas y ningún envío/provisionamiento
para un correo ausente.

Publicación completada, después de dry-runs y revisión independiente de seguridad:

- Fuentes API: `42a5ae2`; Core Worker `53d0bddc-2624-4ccd-9868-61467d573e77`.
- API application versión 5: una instancia saludable, cero errores, sin rollout
  activo. Imagen inmutable
  `registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/mindbliss/api-login-recovery-20261030@sha256:ba14d85cf8de2a0315caba70991c7374a5ff8dde2e1574c5d610f13288da1356`.
- Fuentes portal: `7e2ca2c`; Worker `469f02c7-7d8b-40c0-ba10-5f78f57acaea`.
- Fuentes admin: `4cebdcd`; Worker `0a02e808-ab8c-40b7-a22b-f31b3f660c79`.

Portal: 397 pruebas, typecheck y lint aprobados; admin: 285 pruebas y lint
aprobados. Builds Linux y smoke workerd offline sobre imagen y exportación exacta
aprobados: 50 sondas del portal y 31 del admin, sin red, DB ni mensajes reales.
Los artefactos locales anteriores se conservaron en el directorio ignorado
`.wrangler/artifacts-before-login-recovery-20261030` de cada frontend.

Comprobaciones públicas después de publicar: 13 sondas del portal y 10 del admin
aprobadas, incluyendo login/registro, sesiones anónimas, permisos, JWKS, rechazo
CSRF, rechazo de cuerpo sin destinatario, assets con ETag y 404 sin caché larga.
No son una prueba de entrega de OTP. No hubo nuevos mensajes reales ni cuentas.
La migración masiva de accesos y las nuevas pruebas reales siguen pendientes de
respuesta del propietario; no forman parte de esta publicación técnica.

Las versiones, digests y timestamps de los tres servicios Go se compararon antes
y después: sin cambios. Puertas financieras, árbol/rangos y Chatwoot intactos.

Referencias: [Email OTP](https://better-auth.com/docs/plugins/email-otp),
[Cloudflare REST](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[estados de entrega](https://developers.cloudflare.com/email-service/observability/logs/),
[analítica](https://developers.cloudflare.com/email-service/observability/metrics-analytics/).
