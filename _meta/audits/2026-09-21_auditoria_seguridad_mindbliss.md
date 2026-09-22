# Auditoría de seguridad Mindbliss Power — 2026-09-21

Solo lectura. Sin cambios aplicados. Alcance: EC2 APP `i-060e76a6c26bded35`, WORKER `i-02fcc4d2329040711`, staging `i-0f7f6c73503537d73`, soporteCRM (Chatwoot) `i-09d8295b8580fc847`, RDS `database-mindlisspower` (+ réplica), Cognito `us-east-1_8tLjOfPH1`, SES `mindblisspower.com`, repos `mindblisspower-back`, `mindblisspowerfront`, `mindblisspower-admin`, fork `chatwoot-gh`.
Instancias de otros proyectos de la cuenta (BMP, trustwisebank, nexaru, dvflow, etc.) NO fueron tocadas; solo se anota lo que afecta a Mindbliss.

Cuatro revisiones: (1) pentest infra + auth, (2) DBA Postgres, (3) backend OTP/correo/teléfono, (4) Chatwoot + vp-support.

---

## ALTO

| # | Hallazgo | Dónde | Remediación |
|---|---|---|---|
| A1 | **SSH 22 abierto a 0.0.0.0/0** en el SG compartido (la regla /32 queda inútil). 763/1250/2053 intentos fallidos en 7 d (APP/WORKER/staging). fail2ban y ufw inactivos. La llave RSA `alaindevsenior` (pem perdido) sigue en `authorized_keys` de root y ubuntu en las 3 cajas. | `sg-00bc3b29df49c4597` | `revoke-security-group-ingress --port 22 --cidr 0.0.0.0/0`; usar SSM Session Manager; quitar `alaindevsenior` de authorized_keys; `apt install fail2ban`. |
| A2 | **`REQUIRE_VERIFIED_IDENTITY` no está en prod** → backend acepta identidad declarada por header si falta `X-VP-Id-Token`; todo el plano admin depende del `PAYMENTS_SERVICE_TOKEN`, que además es la clave HMAC de `vp_act_as` y de los links "reanudar pago". `vp-withdrawals` y `vp-support` tienen `SetIdentityVerifier(verifier,false)` hardcodeado. | `payments/config.go:195`, `http.go:736-746`, `cmd/vp-withdrawals/main.go:83`, `cmd/vp-support/main.go:102` | SSM param `/vicionpower/prod/vp-payments/REQUIRE_VERIFIED_IDENTITY=true` + redeploy; misma bandera en withdrawals/support; secretos separados para act-as y cart-resume. |
| A3 | **Panel admin sin rate limit** en `code-login/request` y `confirm`; no filtra allowlist antes de `InitiateAuth` → cualquier email de miembro recibe OTPs disparados desde admin.; brute force del código solo frenado por Cognito. | `mindblisspower-admin/src/app/api/auth/cognito/code-login/{request,confirm}/route.js` | Portar `rate-limit.js`/`auth-rate-limit.js`/`otp-send-policy.js` del front; comprobar allowlist antes de `InitiateAuth`. |
| A4 | **IAM**: usuario `MINDBLISS` (grupo admin) sin MFA, access key en claro en `backend/.env.local` junto a `RDS_MASTER_PASSWORD`, `sk_live`, `BMP_CLIENT_SECRET`; root con access keys; sin password policy. | IAM cuenta 522814703714 | MFA en MINDBLISS; rotar key; borrar keys de root; password policy; sacar `.env.local` a SSM/Secrets Manager. |
| A5 | **`migrator` es miembro de `rds_superuser` y `postgres`** (login, sin límite ni caducidad). | RDS roles | `REVOKE rds_superuser FROM migrator; REVOKE postgres FROM migrator; ALTER ROLE migrator CONNECTION LIMIT 2 VALID UNTIL ...`. |
| A6 | **Sin auditoría ni alarmas en RDS**: log_connections/disconnections off, sin pgaudit, sin export a CloudWatch, 0 alarmas. | parameter group `vicionpower-pg17` | Parámetros de log + pgaudit (reboot en ventana) + export postgresql + alarmas FreeStorage/CPU/Connections/ReplicaLag. |
| A7 | **~11.6 GB de 14 GB son copias con PII** legibles por roles de app: schema `staging` (person 118k con email/phone/birthday, movement 31M filas), 12 tablas `mlm.*_bak` sin PK (incl. `blacklist_bak_20260725` 3215 personas, `person_prereenroot_bak` con ssn/wallet). | RDS `staging.*`, `mlm.*_bak` | Snapshot manual → exportar a S3 cifrado si hace falta → `DROP`. Mientras: `REVOKE ALL ... FROM app_read, app_write, engine_write`. |
| A8 | **Chatwoot sin backups ni snapshots**, EBS sin cifrar y `DeleteOnTermination`; sin alarmas. | `vol-08cba9704b246884a`, soporteCRM | DLM snapshot diario, `pg_dump` a S3 cifrado, `disable-api-termination`, alarmas StatusCheck. |
| A9 | **Chatwoot comparte el instance profile `vp-ec2-ssm`** → puede leer secreto master RDS, todos `vicionpower/*`, KYC S3, banear Cognito. Además el box tiene copia local de vp-support con `DATABASE_URL` de RDS (`vp_engine`). | rol `vp-ec2-ssm` en soporteCRM | Rol propio `chatwoot-ec2` (SSM core + `ChatwootSupportIngressRead` + sus secretos); `replace-iam-instance-profile-association`; evaluar retirar la copia local de vp-support (WORKER ya corre la nueva). |
| A10 | **Runner self-hosted de GitHub en soporteCRM con `ubuntu NOPASSWD:ALL`**, despliega como root en cada push a `develop` del fork. | `/opt/actions-runner`, workflow `mindbliss-chatwoot-deploy.yml` | Required reviewers en environment `production` + branch protection; sudoers limitado al script de deploy. |
| A11 | **Chatwoot `/super_admin` público sin allowlist, 2FA OFF en los 5 usuarios (incl. SuperAdmin)**, v4.17.1 vs 4.18.0 (hardening de sign-in/webhooks/media). | soporteCRM nginx `chatwoot.conf` | `location ^~ /super_admin { allow <IP ops>; deny all; }`; activar 2FA; planificar upgrade 4.18.x (rebase del fork). |

## MEDIO

| # | Hallazgo | Dónde | Remediación |
|---|---|---|---|
| M1 | Enumeración de usuarios en growth-hub confirmada en vivo: `code-login/request` 404 `needsRegister`/`legacy`, 403 `user_disabled`, 409 `needsConfirm`; `register` 409 `accountExists`. Trade-off de negocio documentado; el panel admin sí responde uniforme (Cognito `PreventUserExistenceErrors`). | `mindblisspowerfront/.../code-login/request/route.js:68-140`, `register/route.js:137-159` | Respuesta uniforme 200 "si existe enviamos código"; no exponer `legacy`; confirmar aceptación consciente del trade-off. |
| M2 | Rate limit en memoria de proceso (se pierde en cada deploy, no compartido); fallback a `x-real-ip` spoofable. | `mindblisspowerfront/src/lib/rate-limit.js:13,77-82` | Buckets en Redis (127.0.0.1:6379 ya existe en APP); límite global por endpoint. |
| M3 | Cookie del challenge OTP `vp_cognito_code_challenge` es base64 plano sin HMAC (contiene email, username, Session de Cognito). HttpOnly+Secure+Lax sí. | growth-hub `code-login/request/route.js:330-333`; admin `:179-182` | Firmar con HMAC (clave de servidor) y verificar antes de usar. |
| M4 | Cognito prod: sin Threat Protection (`UserPoolAddOns null`, tier PLUS pagado sin usar), MFA OFF, `ALLOW_USER_PASSWORD_AUTH`/`ADMIN_USER_PASSWORD_AUTH` habilitados, callbacks `localhost` en prod. | pool `us-east-1_8tLjOfPH1`, client `2daar7…` | `update-user-pool --user-pool-add-ons AdvancedSecurityMode=ENFORCED` + `set-risk-configuration`; quitar localhost; SRP en vez de password auth. |
| M5 | API legacy Better Auth publicada en `api.mindblisspower.com` (ALB → WORKER:3000) con auto-registro abierto (exige verificación de email y 12+ chars), fuera de Cognito y de `mlm.blacklist`; `sign-in/email` devuelve 500 con usuario inexistente; sin HSTS/CSP en el ALB. | `backend/app/src/auth.ts:32-36` | `disableSignUp: true` o retirar listener/DNS si no se usa; corregir el 500. |
| M6 | EBS sin cifrar en APP y WORKER (4 volúmenes con envs y datos qdrant/falkordb). | `vol-0bfa…`, `vol-06f7…`, `vol-09cd…`, `vol-0e0a…` | Snapshot → copia cifrada → swap; `enable-ebs-encryption-by-default`. |
| M7 | SG del RDS permite 5432 desde el SG de soporteCRM y desde el SG compartido que también usa staging; réplica sin DeletionProtection; sin export de logs; sin IAM auth. | `sg-07d3e2f8ed1a6a4ba` | Revocar `sg-071f6357534390a1e`; SG dedicado para staging; `--deletion-protection` en la réplica. |
| M8 | Secretos en archivos world-readable: `/opt/mindbliss/web/.env.local` 644 con `COGNITO_CLIENT_SECRET` prod y `PAYMENTS_SERVICE_TOKEN`; staging tiene el secreto del pool prod y comparte rol, SG y bucket KYC prod; backup `/opt/vicion/vicion-admin.backup-*` con envs. | APP, staging | Borrar `.env.local` en cajas (o 600 sin secretos prod); rol `vp-ec2-ssm-staging` limitado a `vicionpower/staging/*`; bucket KYC de staging. |
| M9 | Impersonación "Ver como": bloqueo de mutaciones no uniforme en backend (plan/simulate, propose, decide, admin/block usan `resolveIdentity`; withdrawals no conoce `X-VP-Act-As`). Hoy protege solo el panel. | `payments/http.go:337,405,448,872`, `withdrawals/http.go:183-202` | Usar `effectiveIdentity` en todos los handlers y portar a withdrawals. |
| M10 | Spoofing de correo: SPF `~all`, DMARC `p=none` sin `rua`; cuenta SES compartida con 20+ identidades sin identity policy restrictiva. Receipt rule de Chatwoot con `TlsPolicy: Optional`. | DNS mindblisspower.com, SES | `p=quarantine; rua=…` → `reject`; `-all`; identity policy Deny salvo vp-ec2-ssm/Cognito/WorkMail/chatwoot-smtp; `TlsPolicy: Require`. |
| M11 | GuardDuty no habilitado. | cuenta | `guardduty create-detector --enable`. |
| M12 | `sesErr` cacheado para siempre por `sync.Once`: un fallo transitorio de credenciales deja el envío roto hasta reiniciar. | `payments/email.go:31-47` | Cachear solo el cliente; reintentar si hubo error. |
| M13 | Sin outbox/reintento de correos: comprobantes y notificaciones fallidas solo se loguean como `non-fatal` (44 comprobantes perdidos 12–21 sep). Goroutines de notificación sin `recover()` ni límite de concurrencia. | `tickets.go:752-835,1052-1063` | Tabla `support.email_outbox` + cron con backoff + evento `email.send_failed`; `defer recover()` y semáforo. |
| M14 | PII en claro sin RLS; `vp_web` (BFF) lee las 191 tablas de `mlm` (person, blacklist, kyc_document, member_onboarding con document_number/address). `ssn_encrypted` existe pero 0 filas. | RDS grants | Vistas públicas para `vp_web` + `REVOKE SELECT` en tablas sensibles; `pgp_sym_encrypt` para document_number/wallet/transcripts. |
| M15 | Calidad de identificadores: teléfonos E.164 válidos 115 de 121 192; 6 931 números compartidos por ≥2 personas (máx 47); 140 emails inválidos, 130 con espacios, 381 dominios typo, 203 TLD typo; sin `email_verified`/`phone_verified` en `mlm.person`. Front valida solo E.164 genérico, no longitud por país. | `mlm.person`; `mindblisspowerfront/src/lib/phone.js:12-14` | Columna `phone_e164` + CHECK; CHECK de email `NOT VALID` + limpieza; `email_verified_at` sincronizado desde Cognito; longitud por país en `isValidE164`. |
| M16 | `WHERE lower(p.email)=lower($1)` en 30 queries Go anula el índice citext: `mlm.person` 206k seq scans / 12.3 mil millones tuplas; `mlm.tree_event` 1.19M seq scans (query pv_credit sin índice por `occurred_at`). Inocuo hoy (CPU 1.5 %), crece con el árbol. | `payments/member.go`, `store.go`, `withdrawals/*`, `bonusengine/candidate.go` | `WHERE p.email = $1` (citext) o `CREATE INDEX CONCURRENTLY person_email_lower_idx ON mlm.person (lower(email::text))`; `tree_event_kind_occurred_idx ON mlm.tree_event (occurred_at) WHERE kind='pv_credit'`. |
| M17 | `pg_stat_statements` no cargado; temp files 73 GB con `work_mem=4MB`. | parameter group | `shared_preload_libraries` + `work_mem=32MB`, `log_temp_files=10240`, `temp_file_limit=2GB`. |
| M18 | Secreto master RDS sin rotación, KMS default, legible por el rol EC2 (`vp-ssm-read`). | `vicionpower/prod/rds-master` | Rotación 90 d; quitar `rds-master` del rol EC2; evaluar IAM auth para `vp_engine`. |
| M19 | Sin control de migraciones; drift: `mlm.is_blacklisted` viva es la de `43` (exige birthdate), no la de `56`; las 47 filas de blacklist no tienen birthdate → la función SQL nunca veta por nombre (el precheck Go sí lo hace inline). | RDS | Reaplicar `56`; tabla `mlm.schema_migration(version, applied_at, checksum)`. |
| M20 | Chatwoot: nginx `client_max_body_size 0` y `server_tokens` visibles; widget web sin HMAC obligatorio (riesgo si se usa `setUser`); fork divergente construido en el host (clon local atrás de prod); 44 paquetes pendientes + reboot requerido; fail2ban/auditd inactivos; contraseñas en `.env.*backup*` de `/opt/chatwoot/source`. | soporteCRM | `client_max_body_size 45m; server_tokens off;`; "Enforce User Identity Validation" al identificar usuarios; sincronizar clon y rebase; `apt full-upgrade && reboot`; borrar `.env.*backup*`. |
| M21 | Contraseñas de `vp_engine` (RDS) y FalkorDB quedaron en salidas intermedias de la auditoría (archivos locales ya borrados). | — | Rotar `vp_engine` y `FALKORDB_PASSWORD` cuando sea conveniente. |

## BAJO

- B1 Servicios internos en `0.0.0.0` protegidos solo por SG: APP `:3000`, `:9095`, `:9097`; WORKER `:3000`, `:3001` grafana, `:9096`, `:9100`; staging idem. Pasar a `127.0.0.1` (`PAYMENTS_HTTP_ADDR`, `WITHDRAWALS_HTTP_ADDR`, `SUPPORT_HTTP_ADDR`, `HOSTNAME=127.0.0.1` en `mindbliss-web.service`).
- B2 REBOOT REQUIRED en las 3 cajas (uptime 115/115/99 d); `compose-vp-engine-1` y qdrant en WORKER corren como root.
- B3 `GET /api/auth/logout` desloguea (CSRF de logout); panel sin check de `Origin` (solo SameSite=Lax); sin contador de fallos por Session en `code-login/confirm`.
- B4 PII (email) en logs del backend Go (~20 `Str("email",…)`) y `checkout/route.js:43`; en runtime 72 h no salió ninguno. Homogeneizar con hash como hace el front.
- B5 `access-help` crea tickets con id secuencial para cualquier email (spam limitado solo por preset `send`).
- B6 `supportkb/http.go:87` compara service token con `!=` (no constante); `withdrawals/http.go:511-517` confía en XFF sin rate limit; rate limit fail-open sin Redis (`payments/cache.go:155-162`); super_admin por defecto hardcodeado (`config.go:176-177`).
- B7 Config drift: `compose-vp-engine-1` en APP corre con `ENV=staging`, `NATS_URL` vacío y modelo `deepseek-v4-pro` contra la DB de producción.
- B8 Staging: Caddy sin cabeceras de seguridad; pool staging sin DeletionProtection.
- B9 Bucket KYC `vp-kyc-mindblisspower` SSE-S3 (no KMS) sin versioning.
- B10 SMTP fallback permite `SMTP_TLS_MODE=none` con AUTH PLAIN (`email.go:139,186-190`); latente, SMTP no configurado en prod.
- B11 RDS: 113 índices sin uso (4.9 GB, 4.6 en staging; `mlm.affiliate_path_btree` 401 MB con 4 scans); FKs sin índice (`affiliate.current_rank_id` conviene); `wallet_movement` 146 particiones (142 vacías), `audit.activity_log` 66 para 3 filas; cron jobs 2-4 inactivos; sin timeouts por rol (`idle_in_transaction_session_timeout=24h`); `vp_engine` con DELETE en `support` y SELECT en `cron.job`; `vp_api` con INSERT/UPDATE en 209 tablas y 0 carga en 7 d (candidato NOLOGIN).
- B12 Support: sin FK `ticket.assigned_to → agent(email)`; ningún agente con specialty `bmp` (auto-asignación cae a `general`); 192 tickets, 190 open, 191 sin asignar → la auto-asignación no se estaba aplicando antes del deploy de hoy.
- B13 Blacklist: normaliza últimos 10 dígitos (no E.164); 47 entradas email+nombre sin teléfono ni fecha → veto por nombre completo sin fecha (homónimos); 342 personas `blacklisted=t` de las que solo 45 coinciden con la lista actual.
- B14 Réplica `db.t4g.small` sin PI/EM; `ReplicaLag` ~50 s en CloudWatch es artefacto de bajo volumen (replay_lag real 1.5 ms).
- B15 Chatwoot: SNS/S3 sin KMS; secreto `chatwoot-smtp` sin rotación; `.env` con keys de Stripe/AWS/FB/Twitter posiblemente vacías; contenedores sin `mem_limit`/log rotation; cuenta huérfana `agent2` y 4 invitaciones sin confirmar; regla SG 3000 inerte; widget cargado en `*.sslip.io`.

## INFO / fuera de alcance (solo reporte)
- SG `default` `sg-0f871058fe360d26e` con 3306 abierto a 0.0.0.0/0 en 3 RDS MySQL públicos de otros proyectos (no afecta a Mindbliss).
- RDS sobredimensionado: `r7g.xlarge` con CPU 1.5 %, 17-26 conexiones, ~2.4 GB útiles.
- ECR tags MUTABLE; FalkorDB password visible en `docker inspect` (solo loopback).

## Lo que está bien
- IMDSv2 required en todas; `vp-gha-deploy` OIDC restringido a repo/ramas; `kms:Decrypt *` solo `ViaService=ssm`.
- Caddy APP: HSTS, X-Frame DENY, nosniff, Referrer-Policy; `/api/admin/*` 401/404 correctamente; sin open redirect.
- JWT verificado con JWKS (iss/aud/exp/token_use) en growth-hub, panel y Go; mismatch declarado vs verificado → rechazo. Cookies HttpOnly+Secure+Lax; SecretHash correcto.
- Service token en tiempo constante (payments, withdrawals); Stripe webhook con firma y MaxBytesReader; Twilio HMAC con `hmac.Equal` y verificación activa en prod; SQL 100 % parametrizado; correo admin texto plano BCC con cabeceras saneadas; Lambda CustomMessage escapa HTML.
- RDS: privado, KMS, force_ssl, TLS 1.3 en el 100 % de conexiones, scram-sha-256, Multi-AZ, backups 7 d, PI 465 d; ningún superuser real salvo A5; `PUBLIC` sin CREATE; email citext único sin duplicados; secuencias bigint; partman OK; 0 funciones con EXECUTE dinámico ni SECURITY DEFINER.
- SES: producción, cuota sana, DKIM + MAIL FROM, config set `cognito-otp` con supresión; usuario SMTP de Chatwoot acotado a `soporte@` + config set.
- Chatwoot: SG correcto, IP elástica, HTTPS LE + HSTS, PG/Redis/Qdrant/Rails solo loopback, signup cerrado, rack-attack activo, Sidekiq no expuesto, webhook del agent bot firmado y verificado, S3/SNS con `SourceAccount`, suscripción SNS confirmada.

## No verificado
- Límite de intentos de Cognito por Session para EMAIL_OTP/SMS_OTP.
- Required reviewers del environment `production` del fork de Chatwoot.
- Tipo de hash de roles antiguos (`rds_tools` no instalado); contenido de logs de PostgreSQL; bloat real.
- CVEs concretos entre Chatwoot 4.17.1 y 4.18.0.
- Límite de gasto de la key OpenRouter compartida por vp-support / support-agent / voice-agent.
