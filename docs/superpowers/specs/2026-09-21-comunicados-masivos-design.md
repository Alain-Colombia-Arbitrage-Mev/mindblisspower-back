# Comunicados masivos por correo — diseño

Fecha: 2026-09-21. Estado: aprobado en conversación, pendiente de revisión del spec.

## 1. Objetivo

Permitir que la operación de Mindbliss envíe un mensaje general por correo a segmentos de miembros desde el panel admin (`admin.mindblisspower.com`), con aprobación four-eyes, envío controlado por SES y seguimiento de entregas por destinatario.

No cubre: WhatsApp/SMS (campañas de Chatwoot), avisos dentro de la app (sección `communications` de growth-hub), ni correos individuales (la página Correos actual sigue igual).

## 2. Decisiones tomadas

| Decisión | Valor |
|---|---|
| Canal | Correo vía SES, identidad `mindblisspower.com`, config set `entregas`. |
| Audiencia | Segmentos elegibles por el admin (ver §4). Nunca "todo el padrón" sin filtro. |
| Control | Cualquier admin redacta y solicita; un super_admin **distinto** aprueba y dispara. Reutiliza `mlm.approval_request`. |
| Formato | Plantilla HTML de marca + versión texto plano. Pie obligatorio con enlace de baja y aviso de spam. |
| Ritmo | 1 correo por destinatario (sin BCC), máximo 10 envíos/s (cuota SES 14/s), lotes de 100. |
| Seguimiento | Eventos SES (Send/Delivery/Bounce/Complaint) por `ses_message_id`, consumidos desde una cola SQS suscrita al topic existente `ses-entregas-eventos`. |
| Bajas | Enlace de baja firmado por destinatario; lista `comms.unsubscribe` respetada en todo envío masivo futuro. |

## 3. Arquitectura

```
Panel admin (Next.js)                 vp-payments (Go)                         AWS
────────────────────                  ─────────────────                        ───
/dashboard/comunicados  ──BFF──▶  /api/admin/comms/campaigns/*  ──▶ RDS comms.*
  redactar / previsualizar               │                                       
  solicitar aprobación                   ├─ ProposeCampaign  → mlm.approval_request (op 'comms_campaign')
  aprobar / rechazar (super_admin)       ├─ DecideCampaign   → approved → encola destinatarios
  ver progreso y métricas                │
                                         ├─ campaignSender (goroutine, ticker) ──▶ SES SendEmail
                                         │      lotes de 100, 10/s, reintentos con backoff
                                         └─ sesEventConsumer (goroutine) ◀── SQS comms-ses-events ◀── SNS ses-entregas-eventos
                                                actualiza comms.campaign_recipient por ses_message_id
growth-hub (Next.js)
  GET /baja?t=<token>  ──BFF──▶  /api/comms/unsubscribe  → comms.unsubscribe
```

Todo el código Go vive en `vp-engine/internal/comms/` (paquete nuevo) y se registra en `cmd/vp-payments`. El envío no reutiliza `payments.SendEmail` (texto plano, BCC, sin MessageId): se añade `SendHTMLEmail` en `internal/payments/email.go` (contenido Simple con `Html` + `Text`, un destinatario en `To`, `ConfigurationSetName` configurable, cabeceras `List-Unsubscribe`) que devuelve el `MessageId` de SES.

## 4. Datos (migración `67_comms_campaigns.sql`)

```sql
CREATE SCHEMA IF NOT EXISTS comms;

CREATE TYPE comms.campaign_status AS ENUM
  ('draft','pending_approval','approved','sending','paused','done','cancelled','rejected');

CREATE TABLE comms.campaign (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject            text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  body_markdown      text NOT NULL CHECK (length(body_markdown) BETWEEN 10 AND 20000),
  segment            jsonb NOT NULL CHECK (jsonb_typeof(segment) = 'object'),
  status             comms.campaign_status NOT NULL DEFAULT 'draft',
  approval_request_id bigint REFERENCES mlm.approval_request(id),
  created_by         citext NOT NULL,          -- email admin
  approved_by        citext,                   -- email super_admin
  audience_count     integer,                  -- conteo al aprobar
  sent_count         integer NOT NULL DEFAULT 0,
  delivered_count    integer NOT NULL DEFAULT 0,
  bounced_count      integer NOT NULL DEFAULT 0,
  complained_count   integer NOT NULL DEFAULT 0,
  failed_count       integer NOT NULL DEFAULT 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_status_idx ON comms.campaign(status) WHERE status IN ('approved','sending','paused');

CREATE TYPE comms.recipient_status AS ENUM
  ('queued','sent','delivered','bounced','complained','failed','skipped');

CREATE TABLE comms.campaign_recipient (
  campaign_id     bigint NOT NULL REFERENCES comms.campaign(id) ON DELETE CASCADE,
  person_id       bigint NOT NULL REFERENCES mlm.person(id),
  email           citext NOT NULL,
  status          comms.recipient_status NOT NULL DEFAULT 'queued',
  ses_message_id  text,
  attempts        smallint NOT NULL DEFAULT 0,
  last_error      text,
  skip_reason     text,                        -- 'unsubscribed' | 'blacklisted' | 'bounced_before' | 'invalid_email'
  sent_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, person_id)
);
CREATE INDEX campaign_recipient_queue_idx ON comms.campaign_recipient(campaign_id, status) WHERE status = 'queued';
CREATE UNIQUE INDEX campaign_recipient_msgid_idx ON comms.campaign_recipient(ses_message_id) WHERE ses_message_id IS NOT NULL;

CREATE TABLE comms.unsubscribe (
  email        citext PRIMARY KEY,
  person_id    bigint REFERENCES mlm.person(id),
  source       text NOT NULL DEFAULT 'link',   -- 'link' | 'complaint' | 'admin'
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.suppressed_email (           -- rebotes permanentes
  email        citext PRIMARY KEY,
  reason       text NOT NULL,                   -- 'bounce_permanent'
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TYPE mlm.approval_operation_type ADD VALUE IF NOT EXISTS 'comms_campaign';

-- grants: vp_engine SELECT/INSERT/UPDATE en comms.*; app_read SELECT en comms.campaign
```

Trigger `touch_updated_at` en `campaign` y `campaign_recipient` (misma función que usa `support`).

### Segmento (`segment` jsonb)

```json
{
  "status": ["active"],                 // mlm.person.status; default ["active"]
  "rank_ids": [3,4,5],                  // mlm.affiliate.current_rank_id; vacío = todos
  "phone_country_ids": [57, 1],         // mlm.person.phone_country_id; vacío = todos
  "membership": "active|expired|any",   // según mlm.affiliate_package.status
  "emails": ["a@x.com", "..."]          // lista pegada; si viene, ignora el resto
}
```

Resolución (una sola consulta, `internal/comms/segment.go`):

```sql
SELECT p.id, p.email
  FROM mlm.person p
  LEFT JOIN mlm.affiliate a ON a.person_id = p.id
 WHERE p.status = ANY($status)
   AND NOT p.blacklisted
   AND p.is_admin = false
   AND ($ranks IS NULL OR a.current_rank_id = ANY($ranks))
   AND ($countries IS NULL OR p.phone_country_id = ANY($countries))
   AND ($membership = 'any'
        OR ($membership = 'active'  AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active'))
        OR ($membership = 'expired' AND NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
                                    AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'expired')))
   AND p.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   AND NOT EXISTS (SELECT 1 FROM comms.unsubscribe u WHERE u.email = p.email)
   AND NOT EXISTS (SELECT 1 FROM comms.suppressed_email s WHERE s.email = p.email)
```

Los excluidos por baja, supresión, blacklist o email inválido **no** se insertan en `campaign_recipient`; el conteo de vista previa devuelve `{eligible, excluded: {unsubscribed, suppressed, blacklisted, invalid}}`.

## 5. Flujo y estados

1. **Borrador** (`draft`): admin crea/edita asunto, cuerpo (Markdown limitado: párrafos, negrita, enlaces, listas) y segmento. Vista previa renderizada y conteo real. Puede enviarse una **prueba** a su propio email (máximo 5 por campaña, no cuenta en métricas).
2. **Solicitar** (`pending_approval`): crea `mlm.approval_request` con `operation_type='comms_campaign'`, `payload={campaign_id, subject, audience_count, segment}`, `requires_n_approvers=1`, `initiator_reason` = motivo del admin (≥10 chars). La campaña queda inmutable.
3. **Decidir**: solo `super_admin` con email ≠ `created_by`. `approve` → `approved`, recalcula el segmento en ese momento (`audience_count`), inserta `campaign_recipient` en `queued` dentro de una transacción. `reject` → `rejected` con motivo.
4. **Enviar** (`sending`): el sender toma campañas `approved` (`FOR UPDATE SKIP LOCKED`), marca `sending`, `started_at`, y procesa lotes de 100 `queued` a ≤10/s. Por destinatario: renderiza plantilla con `first_name` y enlace de baja, llama SES, guarda `ses_message_id` y `sent`. Error transitorio (throttling, 5xx) → `attempts+1`, reintento con backoff 1/5/25 min, hasta 3; error permanente (400 destinatario inválido, AccessDenied) → `failed` + `last_error`; AccessDenied además **pausa** la campaña.
5. **Pausar/cancelar**: `paused` detiene el sender sin perder cola; `cancelled` marca los `queued` restantes como `skipped('cancelled')`.
6. **Fin** (`done`): sin `queued` ni reintentos pendientes; `finished_at`.

Solo puede haber **una** campaña en `sending` a la vez (cola FIFO por `approved` más antigua).

## 6. Contenido del correo

- Plantilla HTML única (`internal/comms/template.go`, `html/template`): cabecera con logo dorado, cuerpo renderizado desde Markdown restringido (goldmark con extensiones desactivadas y sanitización bluemonday `UGCPolicy`), pie fijo: razón social, "Recibes este correo porque eres miembro de Mindbliss Power", enlace **Darse de baja** y "revisa tu carpeta de spam".
- Versión texto: el Markdown original + pie.
- `From: Mindbliss Power <no-reply@mindblisspower.com>`; `Reply-To: soporte@mindblisspower.com` (llega a Chatwoot).
- Cabecera `List-Unsubscribe: <https://app.mindblisspower.com/baja?t=…>` y `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (Gmail/Yahoo lo exigen para remitentes masivos).
- Token de baja: `base64url(person_id.expiry.hmac_sha256(secret, person_id|expiry))`, secreto propio `COMMS_UNSUBSCRIBE_SECRET` (no reutilizar `PAYMENTS_SERVICE_TOKEN`), validez 180 días.

## 7. Seguimiento de entregas

- Infra (Terraform-free, comandos AWS documentados en el plan): cola SQS `comms-ses-events` (retención 4 días, DLQ), suscripción del topic SNS `ses-entregas-eventos` a la cola con `RawMessageDelivery=true`, policy IAM en `vp-ec2-ssm`: `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` sobre esa cola.
- `sesEventConsumer` hace long-poll (20 s), parsea el evento SES, busca `ses_message_id` en `campaign_recipient`; `Delivery` → `delivered`, `Bounce` permanente → `bounced` + inserta `comms.suppressed_email`, `Complaint` → `complained` + inserta `comms.unsubscribe(source='complaint')`. Eventos de correos ajenos a campañas (OTP, comprobantes) se descartan. Contadores de campaña se recalculan por `UPDATE ... = (SELECT count(*) ...)` al final de cada lote de eventos.
- El panel muestra por campaña: encolados, enviados, entregados, rebotes, quejas, fallidos, y tabla paginada de destinatarios con estado (sin exportar emails masivamente: máximo 200 por página).

## 8. API backend (`vp-payments`, todas bajo `requireAdmin`; decidir bajo `requireSuperAdmin`)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/admin/comms/campaigns?status=&page=` | listar |
| POST | `/api/admin/comms/campaigns` | crear borrador |
| GET/PUT | `/api/admin/comms/campaigns/{id}` | ver / editar (solo `draft`) |
| POST | `/api/admin/comms/campaigns/{id}/preview` | conteo + HTML renderizado |
| POST | `/api/admin/comms/campaigns/{id}/test` | enviar prueba al admin autenticado |
| POST | `/api/admin/comms/campaigns/{id}/submit` | `draft → pending_approval` |
| POST | `/api/admin/comms/campaigns/{id}/decide` | `{decision, reason}` super_admin ≠ creador |
| POST | `/api/admin/comms/campaigns/{id}/pause` `/resume` `/cancel` | control |
| GET | `/api/admin/comms/campaigns/{id}/recipients?status=&page=` | detalle |
| POST | `/api/comms/unsubscribe` | público vía BFF de growth-hub, `{token}` |

Mutaciones rechazan `X-VP-Act-As` (usar `effectiveIdentity`). Rate limit del BFF: preset `admin` existente.

## 9. Panel admin

- Nueva página `/dashboard/comunicados` (menú Operación): lista con estado y métricas; editor con asunto, cuerpo Markdown, selector de segmento (chips de estado/rango/país/membresía o textarea de emails), botón "Calcular audiencia", "Enviar prueba", "Solicitar aprobación".
- Vista de aprobación (solo super_admin): resumen, audiencia, previsualización HTML en iframe sandbox, motivo, Aprobar/Rechazar.
- Progreso en vivo (polling cada 5 s mientras `sending`).
- BFF: rutas `src/app/api/admin/comms/**` que proxean con `callPayments`, misma convención que `tickets`.

## 10. Configuración

| Var | Servicio | Default |
|---|---|---|
| `COMMS_SEND_RATE_PER_SEC` | vp-payments | 10 |
| `COMMS_BATCH_SIZE` | vp-payments | 100 |
| `COMMS_SES_CONFIG_SET` | vp-payments | `entregas` |
| `COMMS_UNSUBSCRIBE_SECRET` | vp-payments (SSM SecureString) | requerido |
| `COMMS_UNSUBSCRIBE_BASE_URL` | vp-payments | `https://app.mindblisspower.com/baja` |
| `COMMS_SQS_QUEUE_URL` | vp-payments | requerido para seguimiento; vacío = sin consumer |
| `COMMS_ENABLED` | vp-payments | `true` en APP, `false` en WORKER (un solo sender) |

## 11. Errores y límites

- AccessDenied de SES → pausa campaña + evento `comms.campaign_paused` (visible en panel, log Error).
- Throttling SES → backoff exponencial global del sender (empieza 1 s, máx 60 s).
- Caída del proceso a mitad: los `queued` siguen en la tabla; al arrancar, el sender retoma campañas en `sending`. Un destinatario nunca se envía dos veces porque el `UPDATE ... SET status='sent'` se hace antes de la siguiente iteración y el `SELECT` es `FOR UPDATE SKIP LOCKED`.
- Audiencia máxima por campaña: 150 000. Campañas por día: 3 (configurable). Si `bounced_count/sent_count > 5 %` en las primeras 1 000, pausa automática y aviso.
- Contenido: sin adjuntos; enlaces solo `https`; el sanitizador elimina scripts/iframes.

## 12. Pruebas

- Unit (Go, sin DB): resolución de segmento (SQL builder con casos), token de baja (firma, expiración, tamper), render de plantilla (Markdown restringido, escape, pie obligatorio), parser de eventos SES, cálculo de backoff.
- Integración (Go + Postgres testcontainers, como el resto de `payments`): ciclo completo `draft → submit → decide → sending → done` con SES simulado (interfaz `EmailSender`), reintentos, pausa/cancel, exclusiones (unsubscribe/suppressed/blacklist), idempotencia tras reinicio, consumer SQS con eventos sintéticos.
- Front: tests node existentes para el BFF (rate limit, roles); smoke manual en staging con envío real a 3 buzones propios (Gmail, Outlook, Yahoo) verificando inbox, pie, enlace de baja y `List-Unsubscribe`.

## 13. Fuera de alcance / futuro

- Programar envíos a fecha/hora.
- Plantillas múltiples y editor visual.
- A/B de asuntos.
- Campañas por WhatsApp/SMS (Chatwoot) e in-app.
