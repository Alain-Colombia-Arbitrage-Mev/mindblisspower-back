# 0003 — Better Auth en lugar de Cognito/Auth0/Keycloak

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita autenticación + autorización para:

- Afiliados (potencialmente 100k+ activos), con login email/password, OAuth opcional, recovery, 2FA.
- Admins/operadores con roles diferenciados y MFA obligatorio.
- Sesiones con expiración configurable y refresh.
- Audit log de todos los logins/logouts/password changes.

Restricciones:
- **Costo:** modelos por-MAU explotan con crecimiento viral típico de MLM.
- **Lock-in:** auth es la última pieza que quieres rehacer; elegir un provider es contrato de 5+ años.
- **Self-hosted preferido:** ADR 0005 ya elige Hetzner self-hosted; congruencia.
- **Ecosistema TS:** ADR 0002 mantiene `vp-api` en TypeScript.
- **Compliance LATAM:** Habeas Data Colombia exige residencia de datos en jurisdicción manejable.

## Decision

**Better Auth (https://www.better-auth.com/), self-hosted en `vp-api`, persistiendo en Postgres `auth.*` schema.**

Configuración base (en `app/src/auth.ts`):
- email/password con `requireEmailVerification: true` y `minPasswordLength: 12`.
- Email verification + password reset vía Resend.
- Google OAuth opcional (configurable via env).
- Sesiones cookie-based 7 días, refresh diario, cookie cache 5 min.
- Rate limiting 30 req/min por IP en `/api/auth/*`.
- Session storage: Postgres + Redis cache.
- DatabaseHook crea `mlm.person` automáticamente en signup.

`vp-engine` **no** usa Better Auth — confía en `vp-api` vía mTLS (ver ADR 0002 §4 y ADR 0006).

## Consequences

### Positivas

- **Costo $0/MAU.** Solo paga las filas en `auth.session` (TTL 7 días) y `auth.account` (1 row por OAuth link). A 100k MAU eso es <100 MB en Postgres.
- **Self-hosted nativo.** Toda la data de auth vive en el mismo Postgres del negocio; un único backup pgbackrest cubre todo.
- **TypeScript-native.** Drizzle adapter, hooks tipados, integración trivial con Hono.
- **Estándares modernos:** WebAuthn/passkeys, PKCE en OAuth, secure cookies por defecto.
- **MFA built-in:** TOTP, magic links, OTP por SMS opcional.
- **Plugin system** para extender (organizations, teams, impersonation) sin reimplementar core.
- **Sin lock-in real:** la data está en Postgres con shape estándar; migrar fuera = ALTER TABLE + reescribir handler.

### Negativas

- **Operamos auth.** Rotación de `BETTER_AUTH_SECRET`, escalado horizontal (cookies firmadas funcionan; sesiones server-side requieren Redis compartido — ya lo tenemos), parches de seguridad en upgrades.
- **Madurez relativa.** Better Auth es ~2 años de edad; Auth0/Cognito tienen una década. Mitigación: auditoría externa de seguridad antes de fase 3 (cuando el dinero se mueva).
- **No tiene UI hosted** (a diferencia de Auth0). Construimos las pantallas de signup/signin/recovery en el frontend. No es overhead grande pero sí trabajo.
- **MFA por SMS** requiere proveedor extra (Twilio/AWS SNS) — no incluido out-of-the-box. Para MVP usamos TOTP (apps tipo Authy).
- **Compliance certifications** (SOC 2, ISO 27001) las tiene Hetzner pero no Better Auth como producto. Si en algún punto venimos US/regulado pesado, evaluar.

### Neutras

- Better Auth corre dentro de `vp-api`, no como servicio separado. Boundary clara: no necesita su propio escalado.

## Alternatives considered

### AWS Cognito

**Rechazado.**
- $0.0055/MAU después de los primeros 50k. A 100k MAU = $275/mes; a 500k = $2,475/mes; crece más rápido que el negocio.
- IAM lock-in con AWS — el resto del stack está en Hetzner.
- API obtusa, customización limitada (no se puede agregar campos al user table sin Lambda triggers).
- Latencia 50-150ms desde Hetzner a AWS us-east-1.

Tendría sentido si TODO el stack viviera en AWS. No es nuestro caso.

### Auth0

**Rechazado.**
- $240/mes en plan B2C Essentials (max 7,000 usuarios externos). Pasamos eso en el primer mes de operación normal.
- Plan Professional para 10k MAU: ~$1,400/mes.
- Cuando se llega a 100k+ MAU, Auth0 cuesta más que el resto de la infra junta.
- Los pricing tiers cambian frecuentemente — riesgo contractual.

Auth0 es excelente DX pero el modelo de precio es prohibitivo para B2C de alto volumen.

### Clerk

**Rechazado.** Mismo problema que Auth0 — pricing por MAU. $25/mes hasta 10k usuarios, luego $0.02/user/mes ($2,000/mes a 100k). Mejor DX que Auth0 pero igual de incompatible con escala MLM.

### SuperTokens

**Considerado seriamente, perdió por poco.**
- Self-hosted, open source, free.
- API similar en alcance a Better Auth.
- Pero requiere correr un microservicio dedicado (Java/Node) → un componente operativo extra.
- Postgres adapter funciona pero menos pulido que Drizzle adapter de Better Auth.
- Comunidad más pequeña, evolución más lenta.

Si Better Auth desaparece, SuperTokens es Plan B documentado.

### Keycloak

**Rechazado.**
- Java-based, pesado (1+ GB RAM solo para Keycloak).
- Excelente para enterprise SSO multi-protocolo (SAML, OIDC, LDAP) — no es nuestro caso.
- UI admin compleja, documentación inconsistente.
- Otra base de datos a operar (típicamente).

Útil si tuviéramos múltiples aplicaciones internas con SSO. Para una sola app, overkill.

### Ory Kratos + Hydra

**Rechazado.**
- Filosofía "componer servicios pequeños" (Kratos = identity, Hydra = OAuth, Keto = permissions). Bien conceptualmente, pero 3-4 servicios para algo que Better Auth resuelve en uno.
- Documentación dispersa; configuración densa en YAML.
- Bun integration menos directa.

Excelente si construimos un identity provider para terceros. No para nuestra app.

### Custom auth (rolar el nuestro)

**Rechazado categóricamente.** Auth correctamente implementado es difícil — timing attacks en password compare, rotación de secrets, CSRF, fixation, replay, OAuth flow correctness, MFA secret storage. Better Auth ya resolvió todo eso con review pública.

### Lucia Auth

**Considerado.** Más liviano que Better Auth, también self-hosted, mismo modelo de costo. Perdió por:
- API más bajo nivel; nosotros mismos cableamos verification emails, password reset, OAuth providers.
- Better Auth ya viene "baterías incluidas" con la configuración que queremos.
- Lucia anunció retirement del paquete principal en 2024 (transición a "tutorial-style") — no quiero esa incertidumbre en infra crítica.

## References

- `app/src/auth.ts` — configuración real.
- `_meta/schema_mlm.sql` — declaración de `auth.user` para FK desde `mlm.person`.
- ADR 0002 §4 — cómo `vp-engine` (Go) confía en `vp-api` sin validar sesión propia.
- Better Auth docs: https://www.better-auth.com/
- Comparison Auth providers pricing: https://www.descope.com/blog/post/auth-pricing-comparison
- WebAuthn spec: https://www.w3.org/TR/webauthn-2/
