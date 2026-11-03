# Plantillas OTP de Mindbliss Power

Preparadas para `mindblisspower.com`, con el remitente elegido por el titular:
`otp@mindblisspower.com`. Para enviar mediante Resend se necesitan el dominio
verificado, una clave de envío válida y cuota disponible. Preparar estos
archivos no crea un buzón, modifica DNS, compra un plan o envía un correo.
Tampoco confirma despliegue, publicación remota ni entrega real.

| Propósito Better Auth | Alias publicado de Resend | HTML de referencia |
| --- | --- | --- |
| `sign-in` | `login-verification-code` | `inicio-sesion.html` |
| `email-verification` | `account-verification` | `verificar-correo.html` |
| `forget-password` | `password-reset` | `recuperar-contrasena.html` |

Todas usan negro/amarillo del acceso actual, HTML con estilos inline, código
de seis dígitos, vencimiento de cinco minutos y advertencia de seguridad. No
contienen píxeles, fuentes/imágenes externas, enlaces con códigos ni información
financiera. Los TXT son la versión en texto plano del renderizador local.

## Revisar las tres plantillas alojadas

1. Abre [Templates](https://resend.com/templates) y localiza cada alias exacto
   de la tabla. No crees duplicados ni reemplaces una versión publicada sin
   revisión y autorización. El backend no acepta un alias diferente por request.
2. Comprueba el asunto y remitente de `manifest.json`. El emisor proporciona
   `otp@mindblisspower.com` y el asunto del catálogo en cada solicitud.
3. Compara el contenido alojado con el HTML de referencia. Si necesita cambios,
   prepara una revisión antes de importar el archivo y publicar otra versión.
4. Comprueba la variable **OTP**, de tipo **string**, sin valor predeterminado.
   El HTML usa `{{{OTP}}}`. Es string para conservar ceros iniciales.
   Nunca utilices un código fijo como valor de respaldo. En la vista previa
   puedes poner `012345`; es un ejemplo, no un código de acceso real.
5. Confirma que los tres alias estén **Published** y que no exijan otras
   variables sin proveer. Un borrador no puede utilizarse para enviar. No uses
   **Test email** sin autorización para los destinatarios elegidos. Una prueba
   visual del panel no crea un OTP nativo canjeable ni verifica a un usuario.

Referencia oficial: [crear/importar HTML](https://resend.com/docs/dashboard/templates/create-template)
y [variables de plantillas](https://resend.com/docs/dashboard/templates/template-variables).

## Cómo se conectan con el backend

La fuente del mapeo y de las exportaciones es
`app/src/auth/email-templates.ts`. Better Auth genera el código y conserva su
HMAC, propósito, caducidad de 300 segundos y presupuesto de intentos. El callback
compone asunto, texto, HTML y metadatos del alias correspondiente. Ningún dato
de la solicitud puede sustituir el alias o elegir su propio código.

Con **Resend seleccionado**, el OTP se envía usando este contrato; el código
del ejemplo es ficticio y el real siempre procede de Better Auth:

```json
{
  "from": "otp@mindblisspower.com",
  "to": ["miembro@example.test"],
  "subject": "Tu código de acceso | Mindbliss Power",
  "template": {
    "id": "login-verification-code",
    "variables": { "OTP": "012345" }
  }
}
```

`template.id` admite el alias de una plantilla publicada. La variable
`template.variables.OTP` es un string de seis dígitos ASCII; no hay valor
predeterminado, URL, destinatario, nombre ni variables adicionales. Según el
[contrato oficial de envío](https://resend.com/docs/api-reference/emails/send-email),
`template` no puede mezclarse con `html`, `text` ni `react`: el transporte los
excluye en los OTP alojados. Un alias inválido falla antes del envío; un fallo
de la plantilla no activa reintentos, HTML alternativo ni otro proveedor.

Con **Cloudflare seleccionado**, se ignoran los metadatos alojados y se envían
el HTML y texto locales, como antes. Los mensajes genéricos no OTP que no llevan
metadatos conservan HTML/texto en Resend. La selección de proveedor es de servidor,
no un parámetro de login. La edición de plantillas debe hacerse desde el panel
sin ampliar innecesariamente los permisos de la clave de envío.

Los HTML de esta carpeta son exportaciones del mismo renderizador, no una
segunda implementación. Las pruebas verifican catálogo, HTML, texto y duración
locales; no consultan ni demuestran igualdad con una versión remota de Resend.
Modificar una plantilla alojada puede cambiar su contenido enviado, pero no las
reglas de autenticación. No cambian sesiones ni aprobación/vinculación de cuentas.
Recibir un correo no significa que esté validado: es necesario canjear su OTP.
La vista previa local sólo contiene datos sintéticos y no envía mensajes.

## Pendientes de activación

Verifica el estado actual del dominio y DKIM antes de activar Resend. Respeta
los tipos y nombres exactos que muestra el proveedor; las etiquetas «SPF»
o «DKIM» no bastan para deducir siempre el tipo de registro. No borres registros
existentes ni añadas un segundo SPF/DMARC en el mismo nombre.

Resend [no requiere aprobación de producción](https://resend.com/docs/knowledge-base/does-resend-require-production-approval).
Sí deben comprobarse dominio verificado, `RESEND_API_KEY`, los tres alias
publicados y cuota disponible. Su configuración y el despliegue son pasos
operativos independientes de estos archivos. Sólo una prueba autorizada y su
confirmación permiten evaluar entrega real; las plantillas no solucionan una
cuota agotada ni acreditan llegada a la bandeja.
