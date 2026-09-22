# Comunicados masivos por correo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Campañas de correo por segmento desde el panel admin, con aprobación four-eyes, envío por SES con throttling y seguimiento de entregas por destinatario.

**Architecture:** Lógica pura (segmento SQL, token de baja, plantilla, parser de eventos SES, backoff) en un paquete nuevo `internal/comms` sin dependencias de DB. Persistencia, handlers HTTP, sender y consumer SQS en archivos `internal/payments/comms_*.go` (misma package `payments`, para reutilizar `requireAdmin`, `requireSuperAdmin`, `svcAuth`, `Store`). Panel admin y growth-hub proxean vía BFF con el patrón existente (`callPayments` + `X-VP-Service-Token`).

**Tech Stack:** Go 1.25, pgx v5, aws-sdk-go-v2 (sesv2, sqs), goldmark + bluemonday (Markdown seguro), testcontainers (tests de integración con Docker), Next.js (panel admin y growth-hub).

**Spec:** `docs/superpowers/specs/2026-09-21-comunicados-masivos-design.md`

## Global Constraints

- Rutas HTTP planas con `?id=`/body (el mux no usa `PathValue`, ver `internal/payments/http.go:211-213`).
- Toda mutación admin pasa por `requireAdmin`/`requireSuperAdmin` (usan `effectiveIdentity` → rechazan `X-VP-Act-As` en non-GET).
- Ritmo por defecto: `COMMS_SEND_RATE_PER_SEC=10`, `COMMS_BATCH_SIZE=100`, `COMMS_SES_CONFIG_SET=entregas`, `COMMS_MAX_AUDIENCE=150000`, `COMMS_MAX_CAMPAIGNS_PER_DAY=3`, `COMMS_UNSUBSCRIBE_BASE_URL=https://app.mindblisspower.com/baja`.
- Un solo sender activo: `COMMS_ENABLED=true` solo en APP.
- Un destinatario nunca se envía dos veces (at-most-once): filas atascadas en `sending` >10 min pasan a `failed` con `last_error='stale'`.
- Pie obligatorio con enlace de baja y cabeceras `List-Unsubscribe` + `List-Unsubscribe-Post`.
- Nunca loguear emails en claro en niveles Info (usar conteos o `person_id`).
- Tests de integración (`*_integration_test.go`) requieren Docker; CI los corre. Los unit tests de `internal/comms` NO requieren Docker.
- Commits pequeños, mensajes en español, terminar con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ejecutar Go desde `D:\vicionpower\backend\vp-engine` (módulo `github.com/vicionpower/vp-engine`).

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `_meta/migration/67_comms_campaigns.sql` | Schema `comms`, enums, tablas, índices, trigger, grants, valor `comms_campaign` del enum de aprobaciones. |
| `vp-engine/internal/comms/segment.go` | `Segment` (struct + JSON) → SQL parametrizado que resuelve la audiencia. Pura. |
| `vp-engine/internal/comms/unsubscribe.go` | Firma/verificación del token de baja (HMAC). Pura. |
| `vp-engine/internal/comms/template.go` | Markdown restringido → HTML sanitizado + plantilla de marca + versión texto. Pura. |
| `vp-engine/internal/comms/sesevent.go` | Parser mínimo de eventos SES (Delivery/Bounce/Complaint). Pura. |
| `vp-engine/internal/comms/backoff.go` | Backoff de reintentos por destinatario y global. Pura. |
| `vp-engine/internal/payments/email.go` (modificar) | `HTMLEmail`, interfaz `EmailSender`, `Store.SendHTMLEmail` con sesv2 (devuelve MessageId). |
| `vp-engine/internal/payments/comms_store.go` | CRUD de campañas, resolución/encolado de audiencia, actualización de destinatarios y contadores. |
| `vp-engine/internal/payments/comms_approval.go` | Submit/decide four-eyes sobre `mlm.approval_request`. |
| `vp-engine/internal/payments/comms_sender.go` | Loop de envío (claim campaña, lotes, throttling, reintentos, pausa/cancel, cierre). |
| `vp-engine/internal/payments/comms_events.go` | Consumer SQS → estados delivered/bounced/complained, supresión, bajas por queja, auto-pausa. |
| `vp-engine/internal/payments/comms_http.go` | Handlers `/api/admin/comms/*` y `/api/comms/unsubscribe`; registro en `Routes()`. |
| `vp-engine/internal/payments/config.go` (modificar) | `CommsConfig` en `Config` + env. |
| `vp-engine/cmd/vp-payments/main.go` (modificar) | Arranque de sender y consumer. |
| `vp-engine/deploy/vp-payments.env.example` (modificar) | Variables `COMMS_*`. |
| `mindblisspower-admin/src/app/api/admin/comms/**` | BFF proxy. |
| `mindblisspower-admin/src/components/sections/ComunicadosSection.jsx` | UI lista/editor/aprobación/progreso. |
| `mindblisspower-admin/src/app/dashboard/comunicados/page.jsx` + `AdminShell.jsx` | Página y entrada de menú. |
| `mindblisspowerfront/src/app/baja/page.jsx` + `src/app/api/comms/unsubscribe/route.js` | Página pública de baja + BFF. |

---

### Task 1: Migración 67 y harness de tests

**Files:**
- Create: `_meta/migration/67_comms_campaigns.sql`
- Modify: `vp-engine/internal/payments/testhelpers_test.go:96` (lista de migraciones)
- Test: `vp-engine/internal/payments/comms_schema_integration_test.go`

**Interfaces:**
- Produces: tablas `comms.campaign`, `comms.campaign_recipient`, `comms.unsubscribe`, `comms.suppressed_email`; enums `comms.campaign_status`, `comms.recipient_status`; valor `comms_campaign` en `mlm.approval_operation_type`.

- [ ] **Step 1: Escribir el test de integración que falla**

```go
//go:build integration || !short

package payments

import (
	"context"
	"testing"
)

// Requiere Docker (testcontainers). Correr: go test ./internal/payments/ -run Integration
func TestCommsSchema_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='comms'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 4 {
		t.Fatalf("comms tables = %d, want 4", n)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT 'comms_campaign'::mlm.approval_operation_type IS NOT NULL`).Scan(&ok); err != nil || !ok {
		t.Fatalf("enum comms_campaign missing: %v", err)
	}
	var id int64
	err := pool.QueryRow(ctx, `INSERT INTO comms.campaign (subject, body_markdown, segment, created_by)
		VALUES ('Hola', 'Cuerpo de prueba largo', '{"status":["active"]}', 'admin@x.com') RETURNING id`).Scan(&id)
	if err != nil || id == 0 {
		t.Fatalf("insert campaign: %v", err)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd D:\vicionpower\backend\vp-engine && go test ./internal/payments/ -run TestCommsSchema_Integration -count=1`
Expected: FAIL `comms tables = 0, want 4`

- [ ] **Step 3: Escribir la migración**

```sql
-- 67_comms_campaigns.sql — comunicados masivos por correo (campañas por segmento,
-- aprobación four-eyes, cola de destinatarios, bajas y supresión por rebote).
SET search_path = mlm, public;

BEGIN;

CREATE SCHEMA IF NOT EXISTS comms;

DO $$ BEGIN
  CREATE TYPE comms.campaign_status AS ENUM
    ('draft','pending_approval','approved','sending','paused','done','cancelled','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE comms.recipient_status AS ENUM
    ('queued','sending','sent','delivered','bounced','complained','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS comms.campaign (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject             text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  body_markdown       text NOT NULL CHECK (length(body_markdown) BETWEEN 10 AND 20000),
  segment             jsonb NOT NULL CHECK (jsonb_typeof(segment) = 'object'),
  status              comms.campaign_status NOT NULL DEFAULT 'draft',
  approval_request_id bigint REFERENCES mlm.approval_request(id),
  created_by          citext NOT NULL,
  approved_by         citext,
  audience_count      integer,
  test_sends          smallint NOT NULL DEFAULT 0,
  sent_count          integer NOT NULL DEFAULT 0,
  delivered_count     integer NOT NULL DEFAULT 0,
  bounced_count       integer NOT NULL DEFAULT 0,
  complained_count    integer NOT NULL DEFAULT 0,
  failed_count        integer NOT NULL DEFAULT 0,
  pause_reason        text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_active_idx
  ON comms.campaign(status, id) WHERE status IN ('approved','sending','paused');

CREATE TABLE IF NOT EXISTS comms.campaign_recipient (
  campaign_id     bigint NOT NULL REFERENCES comms.campaign(id) ON DELETE CASCADE,
  person_id       bigint NOT NULL REFERENCES mlm.person(id),
  email           citext NOT NULL,
  first_name      text NOT NULL DEFAULT '',
  status          comms.recipient_status NOT NULL DEFAULT 'queued',
  ses_message_id  text,
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  skip_reason     text,
  sent_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, person_id)
);
CREATE INDEX IF NOT EXISTS campaign_recipient_queue_idx
  ON comms.campaign_recipient(campaign_id, next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS campaign_recipient_sending_idx
  ON comms.campaign_recipient(updated_at) WHERE status = 'sending';
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipient_msgid_idx
  ON comms.campaign_recipient(ses_message_id) WHERE ses_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS comms.unsubscribe (
  email       citext PRIMARY KEY,
  person_id   bigint REFERENCES mlm.person(id),
  source      text NOT NULL DEFAULT 'link' CHECK (source IN ('link','complaint','admin')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comms.suppressed_email (
  email       citext PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION comms.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_touch ON comms.campaign;
CREATE TRIGGER campaign_touch BEFORE UPDATE ON comms.campaign
  FOR EACH ROW EXECUTE FUNCTION comms.touch_updated_at();
DROP TRIGGER IF EXISTS campaign_recipient_touch ON comms.campaign_recipient;
CREATE TRIGGER campaign_recipient_touch BEFORE UPDATE ON comms.campaign_recipient
  FOR EACH ROW EXECUTE FUNCTION comms.touch_updated_at();

-- Grants (ejecutar como master; en tests los roles existen sin login)
GRANT USAGE ON SCHEMA comms TO vp_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA comms TO vp_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vp_engine;

COMMIT;

-- Fuera de la transacción: ADD VALUE no puede usarse dentro del mismo bloque
-- en el que luego se referencia el valor.
ALTER TYPE mlm.approval_operation_type ADD VALUE IF NOT EXISTS 'comms_campaign';
```

- [ ] **Step 4: Registrar la migración en el harness**

En `vp-engine/internal/payments/testhelpers_test.go`, después de la línea `"_meta/migration/65_member_onboarding.sql",` añadir:

```go
		"_meta/migration/66_support_bmp_category.sql",
		"_meta/migration/67_comms_campaigns.sql",
```

Nota: `applySchema` ejecuta el prelude antes de `\nBEGIN;` y el resto como un solo `Exec`. El `ALTER TYPE ... ADD VALUE` queda después del `COMMIT;` dentro del mismo `Exec`; Postgres lo acepta porque el bloque ya cerró la transacción (simple query protocol). Si fallara con "unsafe use of new value", mover el `ALTER TYPE` a un archivo `67b_comms_optype.sql` y registrarlo antes del 67.

- [ ] **Step 5: Correr el test y ver que pasa**

Run: `go test ./internal/payments/ -run TestCommsSchema_Integration -count=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd D:\vicionpower\backend
git add _meta/migration/67_comms_campaigns.sql vp-engine/internal/payments/testhelpers_test.go vp-engine/internal/payments/comms_schema_integration_test.go
git commit -m "feat(comms): migración 67 — schema comms (campañas, destinatarios, bajas, supresión)"
```

---

### Task 2: Paquete `internal/comms` — segmento → SQL

**Files:**
- Create: `vp-engine/internal/comms/segment.go`
- Test: `vp-engine/internal/comms/segment_test.go`

**Interfaces:**
- Produces:
  ```go
  package comms
  type Segment struct {
      Status          []string `json:"status"`
      RankIDs         []int16  `json:"rank_ids"`
      PhoneCountryIDs []int16  `json:"phone_country_ids"`
      Membership      string   `json:"membership"` // "active" | "expired" | "any"
      Emails          []string `json:"emails"`
  }
  func ParseSegment(raw []byte) (Segment, error)          // valida y normaliza (defaults)
  func (s Segment) Normalize() Segment
  func AudienceQuery(s Segment) (sql string, args []any)   // SELECT p.id, p.email, p.first_name ... ORDER BY p.id
  func ExclusionCountsQuery(s Segment) (sql string, args []any) // SELECT unsubscribed, suppressed, blacklisted, invalid
  ```

- [ ] **Step 1: Test que falla**

```go
package comms

import (
	"strings"
	"testing"
)

func TestParseSegmentDefaults(t *testing.T) {
	s, err := ParseSegment([]byte(`{}`))
	if err != nil {
		t.Fatalf("ParseSegment: %v", err)
	}
	if len(s.Status) != 1 || s.Status[0] != "active" {
		t.Fatalf("Status default = %v, want [active]", s.Status)
	}
	if s.Membership != "any" {
		t.Fatalf("Membership default = %q, want any", s.Membership)
	}
}

func TestParseSegmentRejectsBadValues(t *testing.T) {
	for _, raw := range []string{
		`{"status":["hacker"]}`,
		`{"membership":"maybe"}`,
		`{"emails":["not-an-email"]}`,
		`[]`,
	} {
		if _, err := ParseSegment([]byte(raw)); err == nil {
			t.Fatalf("expected error for %s", raw)
		}
	}
}

func TestParseSegmentNormalizesEmails(t *testing.T) {
	s, err := ParseSegment([]byte(`{"emails":[" A@X.com ", "b@y.com", "a@x.com"]}`))
	if err != nil {
		t.Fatalf("ParseSegment: %v", err)
	}
	if len(s.Emails) != 2 || s.Emails[0] != "a@x.com" || s.Emails[1] != "b@y.com" {
		t.Fatalf("Emails = %v, want [a@x.com b@y.com]", s.Emails)
	}
}

func TestAudienceQueryAlwaysExcludesBlacklistUnsubscribeAndAdmins(t *testing.T) {
	sql, args := AudienceQuery(Segment{Status: []string{"active"}, Membership: "any"})
	for _, must := range []string{"NOT p.blacklisted", "p.is_admin = false", "comms.unsubscribe", "comms.suppressed_email", "ORDER BY p.id"} {
		if !strings.Contains(sql, must) {
			t.Fatalf("sql missing %q:\n%s", must, sql)
		}
	}
	if len(args) != 5 {
		t.Fatalf("args = %d, want 5 (status, ranks, countries, membership, emails)", len(args))
	}
}

func TestAudienceQueryEmailsListIgnoresFilters(t *testing.T) {
	sql, args := AudienceQuery(Segment{Status: []string{"active"}, RankIDs: []int16{3}, Membership: "active", Emails: []string{"a@x.com"}})
	if !strings.Contains(sql, "$5::text[]") {
		t.Fatalf("sql should filter by email list:\n%s", sql)
	}
	// con lista de emails, ranks/countries/membership viajan como NULL/any
	if args[1] != nil || args[2] != nil || args[3] != "any" {
		t.Fatalf("filters not neutralized: %v", args)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/comms/ -count=1`
Expected: FAIL `undefined: ParseSegment`

- [ ] **Step 3: Implementación**

```go
// Package comms: lógica pura de comunicados masivos (sin DB ni red).
package comms

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

type Segment struct {
	Status          []string `json:"status"`
	RankIDs         []int16  `json:"rank_ids"`
	PhoneCountryIDs []int16  `json:"phone_country_ids"`
	Membership      string   `json:"membership"`
	Emails          []string `json:"emails"`
}

var validStatus = map[string]bool{"pending": true, "active": true, "suspended": true}
var validMembership = map[string]bool{"active": true, "expired": true, "any": true}
var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

const MaxEmailList = 5000

func ParseSegment(raw []byte) (Segment, error) {
	var s Segment
	if len(raw) == 0 {
		raw = []byte(`{}`)
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return Segment{}, fmt.Errorf("segment json: %w", err)
	}
	s = s.Normalize()
	for _, st := range s.Status {
		if !validStatus[st] {
			return Segment{}, fmt.Errorf("segment status inválido: %q", st)
		}
	}
	if !validMembership[s.Membership] {
		return Segment{}, fmt.Errorf("segment membership inválido: %q", s.Membership)
	}
	if len(s.Emails) > MaxEmailList {
		return Segment{}, errors.New("segment emails: máximo 5000")
	}
	for _, e := range s.Emails {
		if !emailRe.MatchString(e) {
			return Segment{}, fmt.Errorf("segment email inválido: %q", e)
		}
	}
	return s, nil
}

func (s Segment) Normalize() Segment {
	if len(s.Status) == 0 {
		s.Status = []string{"active"}
	}
	if s.Membership == "" {
		s.Membership = "any"
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(s.Emails))
	for _, e := range s.Emails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	sort.Strings(out)
	s.Emails = out
	return s
}

// AudienceQuery devuelve el SELECT parametrizado ($1..$5) que resuelve la
// audiencia elegible. Excluye SIEMPRE: blacklisted, admins, bajas, supresión y
// emails con formato inválido. Con lista de emails, los demás filtros se anulan.
func AudienceQuery(s Segment) (string, []any) {
	s = s.Normalize()
	var ranks, countries any
	membership := s.Membership
	var emails any
	if len(s.Emails) > 0 {
		emails = s.Emails
		membership = "any"
	} else {
		if len(s.RankIDs) > 0 {
			ranks = s.RankIDs
		}
		if len(s.PhoneCountryIDs) > 0 {
			countries = s.PhoneCountryIDs
		}
	}
	sql := `
SELECT p.id, p.email::text, p.first_name
  FROM mlm.person p
  LEFT JOIN mlm.affiliate a ON a.person_id = p.id
 WHERE p.status::text = ANY($1::text[])
   AND NOT p.blacklisted
   AND p.is_admin = false
   AND ($2::smallint[] IS NULL OR a.current_rank_id = ANY($2::smallint[]))
   AND ($3::smallint[] IS NULL OR p.phone_country_id = ANY($3::smallint[]))
   AND ($4::text = 'any'
        OR ($4::text = 'active'  AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active'))
        OR ($4::text = 'expired' AND NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
                                 AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'expired')))
   AND ($5::text[] IS NULL OR lower(p.email::text) = ANY($5::text[]))
   AND p.email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   AND NOT EXISTS (SELECT 1 FROM comms.unsubscribe u WHERE u.email = p.email)
   AND NOT EXISTS (SELECT 1 FROM comms.suppressed_email se WHERE se.email = p.email)
 ORDER BY p.id`
	return sql, []any{s.Status, ranks, countries, membership, emails}
}

// ExclusionCountsQuery: cuántos candidatos del segmento quedan fuera y por qué.
func ExclusionCountsQuery(s Segment) (string, []any) {
	_, args := AudienceQuery(s)
	sql := `
WITH base AS (
  SELECT p.id, p.email, p.blacklisted, p.is_admin
    FROM mlm.person p
    LEFT JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE p.status::text = ANY($1::text[])
     AND ($2::smallint[] IS NULL OR a.current_rank_id = ANY($2::smallint[]))
     AND ($3::smallint[] IS NULL OR p.phone_country_id = ANY($3::smallint[]))
     AND ($4::text = 'any'
          OR ($4::text = 'active'  AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active'))
          OR ($4::text = 'expired' AND NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
                                   AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'expired')))
     AND ($5::text[] IS NULL OR lower(p.email::text) = ANY($5::text[]))
)
SELECT
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comms.unsubscribe u WHERE u.email = base.email))        AS unsubscribed,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comms.suppressed_email se WHERE se.email = base.email)) AS suppressed,
  count(*) FILTER (WHERE blacklisted OR is_admin)                                                       AS blacklisted,
  count(*) FILTER (WHERE email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')                                  AS invalid
FROM base`
	return sql, args
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/comms/ -count=1 -v -run Segment`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/comms/segment.go vp-engine/internal/comms/segment_test.go
git commit -m "feat(comms): segmento de audiencia → SQL parametrizado con exclusiones"
```

---

### Task 3: Token de baja (HMAC)

**Files:**
- Create: `vp-engine/internal/comms/unsubscribe.go`
- Test: `vp-engine/internal/comms/unsubscribe_test.go`

**Interfaces:**
- Produces:
  ```go
  func SignUnsubscribe(secret []byte, personID int64, expires time.Time) string
  func VerifyUnsubscribe(secret []byte, token string, now time.Time) (personID int64, err error)
  var ErrUnsubscribeInvalid, ErrUnsubscribeExpired error
  func UnsubscribeURL(baseURL string, token string) string // baseURL + "?t=" + token
  ```

- [ ] **Step 1: Test que falla**

```go
package comms

import (
	"testing"
	"time"
)

func TestUnsubscribeRoundTrip(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	tok := SignUnsubscribe(secret, 4242, now.Add(180*24*time.Hour))
	id, err := VerifyUnsubscribe(secret, tok, now)
	if err != nil || id != 4242 {
		t.Fatalf("verify = %d, %v", id, err)
	}
}

func TestUnsubscribeExpired(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()
	tok := SignUnsubscribe(secret, 1, now.Add(-time.Minute))
	if _, err := VerifyUnsubscribe(secret, tok, now); err != ErrUnsubscribeExpired {
		t.Fatalf("err = %v, want expired", err)
	}
}

func TestUnsubscribeTamper(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()
	tok := SignUnsubscribe(secret, 1, now.Add(time.Hour))
	bad := "9" + tok[1:]
	if _, err := VerifyUnsubscribe(secret, bad, now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid", err)
	}
	if _, err := VerifyUnsubscribe([]byte("other"), tok, now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid (wrong secret)", err)
	}
	if _, err := VerifyUnsubscribe(secret, "garbage", now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid (garbage)", err)
	}
}

func TestUnsubscribeURL(t *testing.T) {
	if got := UnsubscribeURL("https://app.mindblisspower.com/baja", "abc"); got != "https://app.mindblisspower.com/baja?t=abc" {
		t.Fatalf("url = %q", got)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/comms/ -count=1 -run Unsubscribe`
Expected: FAIL `undefined: SignUnsubscribe`

- [ ] **Step 3: Implementación**

```go
package comms

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var (
	ErrUnsubscribeInvalid = errors.New("token de baja inválido")
	ErrUnsubscribeExpired = errors.New("token de baja expirado")
)

// Token: base64url("<personID>|<expUnix>") + "." + base64url(HMAC-SHA256(secret, payload)).
func SignUnsubscribe(secret []byte, personID int64, expires time.Time) string {
	payload := fmt.Sprintf("%d|%d", personID, expires.Unix())
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func VerifyUnsubscribe(secret []byte, token string, now time.Time) (int64, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return 0, ErrUnsubscribeInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return 0, ErrUnsubscribeInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, ErrUnsubscribeInvalid
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return 0, ErrUnsubscribeInvalid
	}
	fields := strings.SplitN(string(payload), "|", 2)
	if len(fields) != 2 {
		return 0, ErrUnsubscribeInvalid
	}
	id, err1 := strconv.ParseInt(fields[0], 10, 64)
	exp, err2 := strconv.ParseInt(fields[1], 10, 64)
	if err1 != nil || err2 != nil || id <= 0 {
		return 0, ErrUnsubscribeInvalid
	}
	if now.Unix() > exp {
		return 0, ErrUnsubscribeExpired
	}
	return id, nil
}

func UnsubscribeURL(baseURL, token string) string {
	sep := "?"
	if strings.Contains(baseURL, "?") {
		sep = "&"
	}
	return baseURL + sep + "t=" + token
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/comms/ -count=1 -run Unsubscribe`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/comms/unsubscribe.go vp-engine/internal/comms/unsubscribe_test.go
git commit -m "feat(comms): token de baja firmado con HMAC"
```

---

### Task 4: Plantilla HTML + Markdown seguro + versión texto

**Files:**
- Create: `vp-engine/internal/comms/template.go`
- Test: `vp-engine/internal/comms/template_test.go`
- Modify: `vp-engine/go.mod` (añadir goldmark y bluemonday)

**Interfaces:**
- Produces:
  ```go
  type RenderInput struct {
      Subject        string
      BodyMarkdown   string
      FirstName      string // puede ir vacío
      UnsubscribeURL string
  }
  type Rendered struct{ Subject, HTML, Text string }
  func Render(in RenderInput) (Rendered, error)   // error si UnsubscribeURL vacío
  ```

- [ ] **Step 1: Añadir dependencias**

Run:
```bash
cd D:\vicionpower\backend\vp-engine
go get github.com/yuin/goldmark@latest github.com/microcosm-cc/bluemonday@latest
go mod tidy
```
Expected: `go.mod` con ambas en `require` (directas).

- [ ] **Step 2: Test que falla**

```go
package comms

import (
	"strings"
	"testing"
)

func TestRenderSanitizesAndAddsFooter(t *testing.T) {
	out, err := Render(RenderInput{
		Subject:        "Novedades",
		BodyMarkdown:   "Hola **equipo**\n\n<script>alert(1)</script>\n\n[Entrar](https://app.mindblisspower.com)\n\n<iframe src=\"x\"></iframe>",
		FirstName:      "Ana",
		UnsubscribeURL: "https://app.mindblisspower.com/baja?t=abc",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(out.HTML, "<script") || strings.Contains(out.HTML, "<iframe") {
		t.Fatalf("html not sanitized: %s", out.HTML)
	}
	for _, must := range []string{"<strong>equipo</strong>", `href="https://app.mindblisspower.com"`, "Hola Ana", "Darse de baja", "https://app.mindblisspower.com/baja?t=abc", "carpeta de spam"} {
		if !strings.Contains(out.HTML, must) {
			t.Fatalf("html missing %q:\n%s", must, out.HTML)
		}
	}
	for _, must := range []string{"Hola **equipo**", "Darse de baja: https://app.mindblisspower.com/baja?t=abc"} {
		if !strings.Contains(out.Text, must) {
			t.Fatalf("text missing %q:\n%s", must, out.Text)
		}
	}
	if out.Subject != "Novedades" {
		t.Fatalf("subject = %q", out.Subject)
	}
}

func TestRenderRejectsHTTPLinksAndRequiresUnsubscribe(t *testing.T) {
	out, err := Render(RenderInput{Subject: "x", BodyMarkdown: "[mal](http://evil.test) [js](javascript:alert(1))", UnsubscribeURL: "https://a/b"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(out.HTML, "http://evil.test") || strings.Contains(out.HTML, "javascript:") {
		t.Fatalf("insecure links kept: %s", out.HTML)
	}
	if _, err := Render(RenderInput{Subject: "x", BodyMarkdown: "hola"}); err == nil {
		t.Fatal("expected error without UnsubscribeURL")
	}
}

func TestRenderGreetingWithoutName(t *testing.T) {
	out, _ := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", UnsubscribeURL: "https://a/b"})
	if !strings.Contains(out.HTML, "Hola,") {
		t.Fatalf("generic greeting missing:\n%s", out.HTML)
	}
}
```

- [ ] **Step 3: Correr y ver que falla**

Run: `go test ./internal/comms/ -count=1 -run Render`
Expected: FAIL `undefined: Render`

- [ ] **Step 4: Implementación**

```go
package comms

import (
	"bytes"
	"errors"
	"html/template"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/renderer/html"
)

type RenderInput struct {
	Subject        string
	BodyMarkdown   string
	FirstName      string
	UnsubscribeURL string
}

type Rendered struct{ Subject, HTML, Text string }

var (
	md = goldmark.New(goldmark.WithRendererOptions(html.WithHardWraps()))
	// Política: solo https/mailto en enlaces, sin imágenes remotas, sin estilos inline.
	policy = func() *bluemonday.Policy {
		p := bluemonday.NewPolicy()
		p.AllowElements("p", "br", "strong", "em", "b", "i", "u", "ul", "ol", "li", "h2", "h3", "blockquote", "hr")
		p.AllowAttrs("href").OnElements("a")
		p.AllowURLSchemes("https", "mailto")
		p.RequireNoFollowOnLinks(false)
		p.AddTargetBlankToFullyQualifiedLinks(true)
		return p
	}()
	insecureLinkRe = regexp.MustCompile(`\]\((http://|javascript:)[^)]*\)`)
)

const htmlTpl = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Subject}}</title></head>
<body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#e8e6e1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" style="max-width:600px;background:#141416;border:1px solid #2a2a2e;border-radius:12px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #2a2a2e"><span style="font-size:18px;font-weight:700;color:#D9B441;letter-spacing:.04em">MINDBLISS POWER</span></td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.55">
<p style="margin:0 0 16px">Hola{{if .FirstName}} {{.FirstName}}{{end}},</p>
{{.Body}}
</td></tr>
<tr><td style="padding:20px 28px;border-top:1px solid #2a2a2e;font-size:12px;line-height:1.5;color:#9a9891">
Recibes este correo porque eres miembro de Mindbliss Power. Si no lo ves en tu bandeja principal, revisa tu carpeta de spam y márcanos como remitente seguro.<br>
<a href="{{.UnsubscribeURL}}" style="color:#D9B441">Darse de baja</a> de los comunicados.
</td></tr></table></td></tr></table></body></html>`

var tpl = template.Must(template.New("mail").Parse(htmlTpl))

func Render(in RenderInput) (Rendered, error) {
	if strings.TrimSpace(in.UnsubscribeURL) == "" {
		return Rendered{}, errors.New("render: UnsubscribeURL requerido")
	}
	src := insecureLinkRe.ReplaceAllString(in.BodyMarkdown, "]()")
	var buf bytes.Buffer
	if err := md.Convert([]byte(src), &buf); err != nil {
		return Rendered{}, err
	}
	safe := policy.SanitizeBytes(buf.Bytes())
	var out bytes.Buffer
	err := tpl.Execute(&out, map[string]any{
		"Subject":        in.Subject,
		"FirstName":      strings.TrimSpace(in.FirstName),
		"Body":           template.HTML(safe),
		"UnsubscribeURL": in.UnsubscribeURL,
	})
	if err != nil {
		return Rendered{}, err
	}
	greeting := "Hola,"
	if n := strings.TrimSpace(in.FirstName); n != "" {
		greeting = "Hola " + n + ","
	}
	text := greeting + "\n\n" + strings.TrimSpace(in.BodyMarkdown) + "\n\n--\n" +
		"Recibes este correo porque eres miembro de Mindbliss Power. Revisa tu carpeta de spam si no lo ves en tu bandeja principal.\n" +
		"Darse de baja: " + in.UnsubscribeURL + "\n"
	return Rendered{Subject: in.Subject, HTML: out.String(), Text: text}, nil
}
```

- [ ] **Step 5: Correr y ver que pasa**

Run: `go test ./internal/comms/ -count=1 -run Render -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add vp-engine/go.mod vp-engine/go.sum vp-engine/internal/comms/template.go vp-engine/internal/comms/template_test.go
git commit -m "feat(comms): plantilla HTML de marca con Markdown sanitizado y versión texto"
```

---

### Task 5: Parser de eventos SES y backoff

**Files:**
- Create: `vp-engine/internal/comms/sesevent.go`, `vp-engine/internal/comms/backoff.go`
- Test: `vp-engine/internal/comms/sesevent_test.go`, `vp-engine/internal/comms/backoff_test.go`

**Interfaces:**
- Produces:
  ```go
  type SESEvent struct {
      Type       string // "Send" | "Delivery" | "Bounce" | "Complaint" | "Reject" | "DeliveryDelay" | "RenderingFailure"
      MessageID  string
      Permanent  bool   // solo Bounce: bounceType == "Permanent"
      Diagnostic string // diagnosticCode / complaintFeedbackType, truncado a 300
  }
  func ParseSESEvent(raw []byte) (SESEvent, error)
  const MaxAttempts = 3
  func RetryDelay(attempt int) time.Duration   // 1→1m, 2→5m, 3→25m; otro → -1
  func IsTransientSESError(err error) bool     // 429/5xx/timeouts/red → true; 4xx → false
  ```

- [ ] **Step 1: Tests que fallan**

`sesevent_test.go`:
```go
package comms

import "testing"

func TestParseSESEventDelivery(t *testing.T) {
	raw := []byte(`{"eventType":"Delivery","mail":{"messageId":"0100abc-1"},"delivery":{"processingTimeMillis":1400}}`)
	ev, err := ParseSESEvent(raw)
	if err != nil || ev.Type != "Delivery" || ev.MessageID != "0100abc-1" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
}

func TestParseSESEventBouncePermanent(t *testing.T) {
	raw := []byte(`{"eventType":"Bounce","mail":{"messageId":"m2"},"bounce":{"bounceType":"Permanent","bounceSubType":"General","bouncedRecipients":[{"diagnosticCode":"smtp; 550 5.1.1 user unknown"}]}}`)
	ev, err := ParseSESEvent(raw)
	if err != nil || !ev.Permanent || ev.Diagnostic != "smtp; 550 5.1.1 user unknown" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
	ev, _ = ParseSESEvent([]byte(`{"eventType":"Bounce","mail":{"messageId":"m3"},"bounce":{"bounceType":"Transient"}}`))
	if ev.Permanent {
		t.Fatal("transient bounce marked permanent")
	}
}

func TestParseSESEventComplaintAndGarbage(t *testing.T) {
	ev, err := ParseSESEvent([]byte(`{"eventType":"Complaint","mail":{"messageId":"m4"},"complaint":{"complaintFeedbackType":"abuse"}}`))
	if err != nil || ev.Type != "Complaint" || ev.Diagnostic != "abuse" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
	if _, err := ParseSESEvent([]byte(`not json`)); err == nil {
		t.Fatal("expected error")
	}
	if _, err := ParseSESEvent([]byte(`{"eventType":"Send"}`)); err == nil {
		t.Fatal("expected error: missing messageId")
	}
}
```

`backoff_test.go`:
```go
package comms

import (
	"errors"
	"testing"
	"time"
)

func TestRetryDelay(t *testing.T) {
	cases := map[int]time.Duration{1: time.Minute, 2: 5 * time.Minute, 3: 25 * time.Minute, 4: -1}
	for attempt, want := range cases {
		if got := RetryDelay(attempt); got != want {
			t.Fatalf("RetryDelay(%d) = %v, want %v", attempt, got, want)
		}
	}
}

type fakeAPIErr struct {
	code   string
	status int
}

func (e fakeAPIErr) Error() string       { return e.code }
func (e fakeAPIErr) ErrorCode() string   { return e.code }
func (e fakeAPIErr) HTTPStatusCode() int { return e.status }

func TestIsTransientSESError(t *testing.T) {
	if !IsTransientSESError(fakeAPIErr{"TooManyRequestsException", 429}) {
		t.Fatal("throttle should be transient")
	}
	if !IsTransientSESError(fakeAPIErr{"InternalFailure", 500}) {
		t.Fatal("5xx should be transient")
	}
	if IsTransientSESError(fakeAPIErr{"AccessDeniedException", 403}) {
		t.Fatal("403 should be permanent")
	}
	if IsTransientSESError(fakeAPIErr{"BadRequestException", 400}) {
		t.Fatal("400 should be permanent")
	}
	if !IsTransientSESError(errors.New("context deadline exceeded")) {
		t.Fatal("timeout should be transient")
	}
	if IsTransientSESError(nil) {
		t.Fatal("nil is not an error")
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/comms/ -count=1 -run 'SESEvent|RetryDelay|Transient'`
Expected: FAIL `undefined: ParseSESEvent`

- [ ] **Step 3: Implementación**

`sesevent.go`:
```go
package comms

import (
	"encoding/json"
	"errors"
)

type SESEvent struct {
	Type       string
	MessageID  string
	Permanent  bool
	Diagnostic string
}

type rawSESEvent struct {
	EventType string `json:"eventType"`
	Mail      struct {
		MessageID string `json:"messageId"`
	} `json:"mail"`
	Bounce struct {
		BounceType        string `json:"bounceType"`
		BouncedRecipients []struct {
			DiagnosticCode string `json:"diagnosticCode"`
		} `json:"bouncedRecipients"`
	} `json:"bounce"`
	Complaint struct {
		ComplaintFeedbackType string `json:"complaintFeedbackType"`
	} `json:"complaint"`
}

func ParseSESEvent(raw []byte) (SESEvent, error) {
	var r rawSESEvent
	if err := json.Unmarshal(raw, &r); err != nil {
		return SESEvent{}, err
	}
	if r.Mail.MessageID == "" || r.EventType == "" {
		return SESEvent{}, errors.New("ses event: falta eventType o messageId")
	}
	ev := SESEvent{Type: r.EventType, MessageID: r.Mail.MessageID}
	switch r.EventType {
	case "Bounce":
		ev.Permanent = r.Bounce.BounceType == "Permanent"
		if len(r.Bounce.BouncedRecipients) > 0 {
			ev.Diagnostic = truncate(r.Bounce.BouncedRecipients[0].DiagnosticCode, 300)
		}
	case "Complaint":
		ev.Diagnostic = truncate(r.Complaint.ComplaintFeedbackType, 300)
	}
	return ev, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
```

`backoff.go`:
```go
package comms

import (
	"context"
	"errors"
	"net"
	"time"
)

const MaxAttempts = 3

// RetryDelay: espera antes del siguiente intento (1m, 5m, 25m). -1 = no reintentar.
func RetryDelay(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Minute
	case 2:
		return 5 * time.Minute
	case 3:
		return 25 * time.Minute
	}
	return -1
}

type apiErrCoder interface{ ErrorCode() string }
type apiErrStatus interface{ HTTPStatusCode() int }

// IsTransientSESError: throttling, 5xx, timeouts y errores de red se reintentan;
// 4xx (AccessDenied, MessageRejected, BadRequest) no.
func IsTransientSESError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || err.Error() == "context deadline exceeded" {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	var st apiErrStatus
	if errors.As(err, &st) {
		code := st.HTTPStatusCode()
		if code == 429 || code >= 500 {
			return true
		}
		if code >= 400 {
			return false
		}
	}
	var c apiErrCoder
	if errors.As(err, &c) {
		switch c.ErrorCode() {
		case "TooManyRequestsException", "Throttling", "ThrottlingException", "SendingPausedException", "LimitExceededException":
			return true
		}
	}
	return false
}
```

Nota: los errores del SDK v2 (`*smithyhttp.ResponseError` envolviendo `*types.TooManyRequestsException`) exponen `ErrorCode()` y `HTTPStatusCode()` a través de `errors.As`, así que no hace falta importar el SDK aquí.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/comms/ -count=1`
Expected: PASS (todo el paquete)

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/comms/sesevent.go vp-engine/internal/comms/sesevent_test.go vp-engine/internal/comms/backoff.go vp-engine/internal/comms/backoff_test.go
git commit -m "feat(comms): parser de eventos SES y política de reintentos"
```

---

### Task 6: `SendHTMLEmail` con MessageId (SES) e interfaz `EmailSender`

**Files:**
- Modify: `vp-engine/internal/payments/email.go` (después de `SendEmail`, línea ~100)
- Test: `vp-engine/internal/payments/email_html_test.go`

**Interfaces:**
- Produces (package `payments`):
  ```go
  type HTMLEmail struct {
      To             string
      Subject        string
      HTML           string
      Text           string
      ReplyTo        string   // "" ⇒ sin Reply-To
      ConfigSet      string   // "" ⇒ sin ConfigurationSetName
      UnsubscribeURL string   // "" ⇒ sin cabeceras List-Unsubscribe
  }
  type EmailSender interface {
      SendHTMLEmail(ctx context.Context, m HTMLEmail) (messageID string, err error)
  }
  func (s *Store) SendHTMLEmail(ctx context.Context, m HTMLEmail) (string, error) // Store implementa EmailSender
  func buildSESHTMLInput(from string, m HTMLEmail) *sesv2.SendEmailInput          // puro, testeable
  ```

- [ ] **Step 1: Test que falla**

```go
package payments

import (
	"testing"
)

func TestBuildSESHTMLInput(t *testing.T) {
	in := buildSESHTMLInput("Mindbliss Power <no-reply@mindblisspower.com>", HTMLEmail{
		To: "ana@example.com", Subject: "Hola", HTML: "<p>x</p>", Text: "x",
		ReplyTo: "soporte@mindblisspower.com", ConfigSet: "entregas",
		UnsubscribeURL: "https://app.mindblisspower.com/baja?t=abc",
	})
	if *in.FromEmailAddress != "Mindbliss Power <no-reply@mindblisspower.com>" {
		t.Fatalf("from = %s", *in.FromEmailAddress)
	}
	if len(in.Destination.ToAddresses) != 1 || in.Destination.ToAddresses[0] != "ana@example.com" || len(in.Destination.BccAddresses) != 0 {
		t.Fatalf("destination = %+v", in.Destination)
	}
	if *in.ConfigurationSetName != "entregas" || in.ReplyToAddresses[0] != "soporte@mindblisspower.com" {
		t.Fatalf("configset/replyto wrong")
	}
	simple := in.Content.Simple
	if *simple.Body.Html.Data != "<p>x</p>" || *simple.Body.Text.Data != "x" {
		t.Fatalf("body wrong")
	}
	var lu, lup string
	for _, h := range simple.Headers {
		switch *h.Name {
		case "List-Unsubscribe":
			lu = *h.Value
		case "List-Unsubscribe-Post":
			lup = *h.Value
		}
	}
	if lu != "<https://app.mindblisspower.com/baja?t=abc>" || lup != "List-Unsubscribe=One-Click" {
		t.Fatalf("list-unsubscribe headers = %q / %q", lu, lup)
	}
}

func TestBuildSESHTMLInputWithoutOptionals(t *testing.T) {
	in := buildSESHTMLInput("a <a@b.c>", HTMLEmail{To: "x@y.z", Subject: "s", HTML: "<p/>", Text: "t"})
	if in.ConfigurationSetName != nil || len(in.ReplyToAddresses) != 0 || len(in.Content.Simple.Headers) != 0 {
		t.Fatalf("optionals should be absent: %+v", in)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run BuildSESHTMLInput`
Expected: FAIL `undefined: buildSESHTMLInput`

- [ ] **Step 3: Implementación** (añadir a `email.go`)

```go
// HTMLEmail: correo individual con HTML + texto, usado por comunicados masivos.
type HTMLEmail struct {
	To             string
	Subject        string
	HTML           string
	Text           string
	ReplyTo        string
	ConfigSet      string
	UnsubscribeURL string
}

// EmailSender abstrae SES para poder testear el sender sin red.
type EmailSender interface {
	SendHTMLEmail(ctx context.Context, m HTMLEmail) (string, error)
}

func buildSESHTMLInput(from string, m HTMLEmail) *sesv2.SendEmailInput {
	msg := &sestypes.Message{
		Subject: &sestypes.Content{Data: aws.String(smtpHeaderValue(m.Subject)), Charset: aws.String("UTF-8")},
		Body: &sestypes.Body{
			Html: &sestypes.Content{Data: aws.String(m.HTML), Charset: aws.String("UTF-8")},
			Text: &sestypes.Content{Data: aws.String(m.Text), Charset: aws.String("UTF-8")},
		},
	}
	if m.UnsubscribeURL != "" {
		msg.Headers = []sestypes.MessageHeader{
			{Name: aws.String("List-Unsubscribe"), Value: aws.String("<" + m.UnsubscribeURL + ">")},
			{Name: aws.String("List-Unsubscribe-Post"), Value: aws.String("List-Unsubscribe=One-Click")},
		}
	}
	in := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(from),
		Destination:      &sestypes.Destination{ToAddresses: []string{strings.ToLower(strings.TrimSpace(m.To))}},
		Content:          &sestypes.EmailContent{Simple: msg},
	}
	if m.ReplyTo != "" {
		in.ReplyToAddresses = []string{m.ReplyTo}
	}
	if m.ConfigSet != "" {
		in.ConfigurationSetName = aws.String(m.ConfigSet)
	}
	return in
}

// SendHTMLEmail envía por SES y devuelve el MessageId (para cruzar eventos).
// No usa el fallback SMTP: los comunicados necesitan MessageId y cabeceras.
func (s *Store) SendHTMLEmail(ctx context.Context, m HTMLEmail) (string, error) {
	if !strings.Contains(m.To, "@") || strings.TrimSpace(m.Subject) == "" || strings.TrimSpace(m.HTML) == "" {
		return "", fmt.Errorf("html email: to/subject/html requeridos")
	}
	client, err := getSES(ctx)
	if err != nil {
		return "", err
	}
	out, err := client.SendEmail(ctx, buildSESHTMLInput(emailFrom(), m))
	if err != nil {
		return "", fmt.Errorf("ses send: %w", err)
	}
	if out.MessageId == nil {
		return "", fmt.Errorf("ses send: sin MessageId")
	}
	return *out.MessageId, nil
}
```

Además corregir el `sync.Once` que cachea el error (hallazgo M12 de la auditoría): reemplazar `getSES` por

```go
var (
	sesMu     sync.Mutex
	sesClient *sesv2.Client
)

func getSES(ctx context.Context) (*sesv2.Client, error) {
	sesMu.Lock()
	defer sesMu.Unlock()
	if sesClient != nil {
		return sesClient, nil
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	sesClient = sesv2.NewFromConfig(cfg)
	return sesClient, nil
}
```
y eliminar `sesOnce`/`sesErr`. Verificar que `smtpHeaderValue` (ya existe en `email.go`) limpia `\r\n`.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run 'BuildSESHTMLInput|SMTP' && go build ./...`
Expected: PASS y build OK. Si `sestypes.MessageHeader` no existe, actualizar el SDK: `go get github.com/aws/aws-sdk-go-v2/service/sesv2@latest && go mod tidy`.

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/email.go vp-engine/internal/payments/email_html_test.go vp-engine/go.mod vp-engine/go.sum
git commit -m "feat(payments): SendHTMLEmail con MessageId y cabeceras List-Unsubscribe; getSES sin cachear errores"
```

---

### Task 7: `comms_store.go` — campañas, audiencia y destinatarios

**Files:**
- Create: `vp-engine/internal/payments/comms_store.go`
- Test: `vp-engine/internal/payments/comms_store_integration_test.go`

**Interfaces:**
- Consumes: `comms.Segment`, `comms.ParseSegment`, `comms.AudienceQuery`, `comms.ExclusionCountsQuery` (Task 2).
- Produces (package `payments`):
  ```go
  type Campaign struct {
      ID int64 `json:"id"`; Subject string `json:"subject"`; BodyMarkdown string `json:"body_markdown"`
      Segment json.RawMessage `json:"segment"`; Status string `json:"status"`
      ApprovalRequestID *int64 `json:"approval_request_id,omitempty"`
      CreatedBy string `json:"created_by"`; ApprovedBy string `json:"approved_by,omitempty"`
      AudienceCount *int `json:"audience_count,omitempty"`; TestSends int `json:"test_sends"`
      SentCount, DeliveredCount, BouncedCount, ComplainedCount, FailedCount int  `json:"sent_count" ...`
      PauseReason string `json:"pause_reason,omitempty"`
      StartedAt, FinishedAt *time.Time; CreatedAt, UpdatedAt time.Time
  }
  type AudiencePreview struct {
      Eligible int `json:"eligible"`
      Excluded struct{ Unsubscribed, Suppressed, Blacklisted, Invalid int } `json:"excluded"`
  }
  type CampaignRecipient struct {
      PersonID int64; Email, FirstName, Status string; SESMessageID string; Attempts int; LastError, SkipReason string; SentAt *time.Time
  }
  var ErrCampaignNotFound, ErrCampaignState, ErrAudienceTooLarge, ErrDailyLimit error

  func (s *Store) CreateCampaign(ctx, createdBy, subject, body string, segment comms.Segment) (Campaign, error)
  func (s *Store) UpdateCampaignDraft(ctx, id int64, subject, body string, segment comms.Segment) (Campaign, error) // solo status draft
  func (s *Store) GetCampaign(ctx, id int64) (Campaign, error)
  func (s *Store) ListCampaigns(ctx, status string, limit, offset int) ([]Campaign, int, error)
  func (s *Store) PreviewAudience(ctx, seg comms.Segment) (AudiencePreview, error)
  func (s *Store) SetCampaignStatus(ctx, id int64, from []string, to string, reason string) error // ErrCampaignState si no está en from
  func (s *Store) EnqueueAudience(ctx, id int64, seg comms.Segment, maxAudience int) (int, error) // transacción: INSERT recipients + audience_count; ErrAudienceTooLarge
  func (s *Store) CountCampaignsApprovedToday(ctx) (int, error)
  func (s *Store) IncrementTestSends(ctx, id int64, max int) error
  func (s *Store) ListCampaignRecipients(ctx, id int64, status string, limit, offset int) ([]CampaignRecipient, int, error)
  func (s *Store) RecipientByMessageID(ctx, msgID string) (campaignID, personID int64, email string, found bool, err error)
  func (s *Store) MarkRecipient(ctx, campaignID, personID int64, status, lastError string) error
  func (s *Store) AddUnsubscribe(ctx, email string, personID *int64, source string) error
  func (s *Store) AddSuppressed(ctx, email, reason string) error
  func (s *Store) RefreshCampaignCounters(ctx, id int64) error
  ```

- [ ] **Step 1: Test de integración que falla**

```go
package payments

import (
	"context"
	"testing"

	"github.com/vicionpower/vp-engine/internal/comms"
)

func seedMember(t *testing.T, ctx context.Context, pool interface{ Exec(context.Context, string, ...any) (interface{ RowsAffected() int64 }, error) }, email, status string, blacklisted bool) {
	t.Helper()
}

func TestCommsStore_CampaignLifecycle_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)

	// 3 activos, 1 baneado, 1 pendiente, 1 con email inválido
	for _, r := range []struct {
		email, status string
		black         bool
	}{
		{"a@x.com", "active", false}, {"b@x.com", "active", false}, {"c@x.com", "active", false},
		{"ban@x.com", "active", true}, {"pend@x.com", "pending", false}, {"bad-email", "active", false},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status,blacklisted)
			VALUES ('N','A',$1,'3000000000',$2::mlm.person_status,$3)`, r.email, r.status, r.black); err != nil {
			t.Fatalf("seed %s: %v", r.email, err)
		}
	}
	if err := store.AddUnsubscribe(ctx, "c@x.com", nil, "link"); err != nil {
		t.Fatalf("unsubscribe: %v", err)
	}

	seg, _ := comms.ParseSegment([]byte(`{"status":["active"]}`))
	prev, err := store.PreviewAudience(ctx, seg)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if prev.Eligible != 2 || prev.Excluded.Unsubscribed != 1 || prev.Excluded.Blacklisted != 1 || prev.Excluded.Invalid != 1 {
		t.Fatalf("preview = %+v", prev)
	}

	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto de prueba", "Cuerpo de prueba largo", seg)
	if err != nil || c.Status != "draft" {
		t.Fatalf("create = %+v, %v", c, err)
	}
	if _, err := store.EnqueueAudience(ctx, c.ID, seg, 1); err != ErrAudienceTooLarge {
		t.Fatalf("expected ErrAudienceTooLarge, got %v", err)
	}
	n, err := store.EnqueueAudience(ctx, c.ID, seg, 150000)
	if err != nil || n != 2 {
		t.Fatalf("enqueue = %d, %v", n, err)
	}
	recs, total, err := store.ListCampaignRecipients(ctx, c.ID, "", 50, 0)
	if err != nil || total != 2 || len(recs) != 2 || recs[0].Status != "queued" {
		t.Fatalf("recipients = %+v total=%d err=%v", recs, total, err)
	}

	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "pending_approval", ""); err != nil {
		t.Fatalf("set status: %v", err)
	}
	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "approved", ""); err != ErrCampaignState {
		t.Fatalf("expected ErrCampaignState, got %v", err)
	}
	if _, err := store.UpdateCampaignDraft(ctx, c.ID, "x", "y", seg); err != ErrCampaignState {
		t.Fatalf("draft edit after submit should fail: %v", err)
	}

	if err := store.MarkRecipient(ctx, c.ID, recs[0].PersonID, "sent", ""); err != nil {
		t.Fatalf("mark: %v", err)
	}
	if err := store.RefreshCampaignCounters(ctx, c.ID); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.SentCount != 1 || got.AudienceCount == nil || *got.AudienceCount != 2 {
		t.Fatalf("counters = %+v", got)
	}
	if _, err := store.GetCampaign(ctx, 999999); err != ErrCampaignNotFound {
		t.Fatalf("expected not found, got %v", err)
	}
}
```

(Eliminar el helper `seedMember` vacío del test antes de commitear: el seed va inline.)

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run TestCommsStore_CampaignLifecycle_Integration`
Expected: FAIL `undefined: ErrAudienceTooLarge` (compilación)

- [ ] **Step 3: Implementación**

```go
package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/comms"
)

var (
	ErrCampaignNotFound = errors.New("campaign_not_found")
	ErrCampaignState    = errors.New("campaign_invalid_state")
	ErrAudienceTooLarge = errors.New("audience_too_large")
	ErrDailyLimit       = errors.New("daily_campaign_limit")
	ErrTestSendLimit    = errors.New("test_send_limit")
)

type Campaign struct {
	ID                int64           `json:"id"`
	Subject           string          `json:"subject"`
	BodyMarkdown      string          `json:"body_markdown"`
	Segment           json.RawMessage `json:"segment"`
	Status            string          `json:"status"`
	ApprovalRequestID *int64          `json:"approval_request_id,omitempty"`
	CreatedBy         string          `json:"created_by"`
	ApprovedBy        string          `json:"approved_by,omitempty"`
	AudienceCount     *int            `json:"audience_count,omitempty"`
	TestSends         int             `json:"test_sends"`
	SentCount         int             `json:"sent_count"`
	DeliveredCount    int             `json:"delivered_count"`
	BouncedCount      int             `json:"bounced_count"`
	ComplainedCount   int             `json:"complained_count"`
	FailedCount       int             `json:"failed_count"`
	PauseReason       string          `json:"pause_reason,omitempty"`
	StartedAt         *time.Time      `json:"started_at,omitempty"`
	FinishedAt        *time.Time      `json:"finished_at,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type AudiencePreview struct {
	Eligible int `json:"eligible"`
	Excluded struct {
		Unsubscribed int `json:"unsubscribed"`
		Suppressed   int `json:"suppressed"`
		Blacklisted  int `json:"blacklisted"`
		Invalid      int `json:"invalid"`
	} `json:"excluded"`
}

type CampaignRecipient struct {
	PersonID     int64      `json:"person_id"`
	Email        string     `json:"email"`
	FirstName    string     `json:"first_name"`
	Status       string     `json:"status"`
	SESMessageID string     `json:"ses_message_id,omitempty"`
	Attempts     int        `json:"attempts"`
	LastError    string     `json:"last_error,omitempty"`
	SkipReason   string     `json:"skip_reason,omitempty"`
	SentAt       *time.Time `json:"sent_at,omitempty"`
}

const campaignCols = `id, subject, body_markdown, segment, status::text, approval_request_id, created_by::text,
	COALESCE(approved_by::text,''), audience_count, test_sends, sent_count, delivered_count, bounced_count,
	complained_count, failed_count, COALESCE(pause_reason,''), started_at, finished_at, created_at, updated_at`

func scanCampaign(row pgx.Row) (Campaign, error) {
	var c Campaign
	err := row.Scan(&c.ID, &c.Subject, &c.BodyMarkdown, &c.Segment, &c.Status, &c.ApprovalRequestID, &c.CreatedBy,
		&c.ApprovedBy, &c.AudienceCount, &c.TestSends, &c.SentCount, &c.DeliveredCount, &c.BouncedCount,
		&c.ComplainedCount, &c.FailedCount, &c.PauseReason, &c.StartedAt, &c.FinishedAt, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Campaign{}, ErrCampaignNotFound
	}
	return c, err
}

func (s *Store) CreateCampaign(ctx context.Context, createdBy, subject, body string, seg comms.Segment) (Campaign, error) {
	segJSON, _ := json.Marshal(seg.Normalize())
	return scanCampaign(s.db.QueryRow(ctx, `INSERT INTO comms.campaign (subject, body_markdown, segment, created_by)
		VALUES ($1,$2,$3,$4) RETURNING `+campaignCols, subject, body, segJSON, createdBy))
}

func (s *Store) UpdateCampaignDraft(ctx context.Context, id int64, subject, body string, seg comms.Segment) (Campaign, error) {
	segJSON, _ := json.Marshal(seg.Normalize())
	c, err := scanCampaign(s.db.QueryRow(ctx, `UPDATE comms.campaign SET subject=$2, body_markdown=$3, segment=$4
		WHERE id=$1 AND status='draft' RETURNING `+campaignCols, id, subject, body, segJSON))
	if errors.Is(err, ErrCampaignNotFound) {
		if _, gerr := s.GetCampaign(ctx, id); gerr == nil {
			return Campaign{}, ErrCampaignState
		}
	}
	return c, err
}

func (s *Store) GetCampaign(ctx context.Context, id int64) (Campaign, error) {
	return scanCampaign(s.db.QueryRow(ctx, `SELECT `+campaignCols+` FROM comms.campaign WHERE id=$1`, id))
}

func (s *Store) ListCampaigns(ctx context.Context, status string, limit, offset int) ([]Campaign, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM comms.campaign WHERE $1='' OR status::text=$1`, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.reader().Query(ctx, `SELECT `+campaignCols+` FROM comms.campaign
		WHERE $1='' OR status::text=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		c, err := scanCampaign(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

func (s *Store) PreviewAudience(ctx context.Context, seg comms.Segment) (AudiencePreview, error) {
	var p AudiencePreview
	sql, args := comms.AudienceQuery(seg)
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM (`+sql+`) q`, args...).Scan(&p.Eligible); err != nil {
		return p, fmt.Errorf("audience count: %w", err)
	}
	sql, args = comms.ExclusionCountsQuery(seg)
	if err := s.reader().QueryRow(ctx, sql, args...).Scan(&p.Excluded.Unsubscribed, &p.Excluded.Suppressed, &p.Excluded.Blacklisted, &p.Excluded.Invalid); err != nil {
		return p, fmt.Errorf("exclusion counts: %w", err)
	}
	return p, nil
}

func (s *Store) SetCampaignStatus(ctx context.Context, id int64, from []string, to, reason string) error {
	tag, err := s.db.Exec(ctx, `UPDATE comms.campaign
		SET status=$3::comms.campaign_status,
		    pause_reason = CASE WHEN $3='paused' THEN NULLIF($4,'') ELSE NULL END,
		    finished_at = CASE WHEN $3 IN ('done','cancelled','rejected') THEN now() ELSE finished_at END
		WHERE id=$1 AND status::text = ANY($2::text[])`, id, from, to, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, gerr := s.GetCampaign(ctx, id); gerr != nil {
			return gerr
		}
		return ErrCampaignState
	}
	return nil
}

// EnqueueAudience resuelve el segmento e inserta los destinatarios en 'queued'.
// Idempotente: ON CONFLICT DO NOTHING. Devuelve el total encolado.
func (s *Store) EnqueueAudience(ctx context.Context, id int64, seg comms.Segment, maxAudience int) (int, error) {
	sql, args := comms.AudienceQuery(seg)
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (`+sql+`) q`, args...).Scan(&n); err != nil {
		return 0, err
	}
	if maxAudience > 0 && n > maxAudience {
		return n, ErrAudienceTooLarge
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	insArgs := append([]any{id}, args...)
	// los $ del subquery se desplazan +1 porque $1 es campaign_id
	shifted := shiftParams(sql, 1)
	if _, err := tx.Exec(ctx, `INSERT INTO comms.campaign_recipient (campaign_id, person_id, email, first_name)
		SELECT $1, q.id, q.email, q.first_name FROM (`+shifted+`) q ON CONFLICT DO NOTHING`, insArgs...); err != nil {
		return 0, fmt.Errorf("enqueue: %w", err)
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1`, id).Scan(&total); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE comms.campaign SET audience_count=$2 WHERE id=$1`, id, total); err != nil {
		return 0, err
	}
	return total, tx.Commit(ctx)
}

// shiftParams renumera $1..$n → $(1+by)..$(n+by). Los placeholders del
// AudienceQuery son $1..$5 y no aparecen otros dígitos tras '$'.
func shiftParams(sql string, by int) string {
	out := make([]byte, 0, len(sql)+8)
	for i := 0; i < len(sql); i++ {
		if sql[i] == '$' && i+1 < len(sql) && sql[i+1] >= '1' && sql[i+1] <= '9' {
			out = append(out, '$', byte('0'+int(sql[i+1]-'0')+by))
			i++
			continue
		}
		out = append(out, sql[i])
	}
	return string(out)
}

func (s *Store) CountCampaignsApprovedToday(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM comms.campaign
		WHERE status IN ('approved','sending','paused','done') AND started_at IS NULL OR started_at >= date_trunc('day', now())`).Scan(&n)
	return n, err
}

func (s *Store) IncrementTestSends(ctx context.Context, id int64, max int) error {
	tag, err := s.db.Exec(ctx, `UPDATE comms.campaign SET test_sends = test_sends + 1 WHERE id=$1 AND test_sends < $2`, id, max)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrTestSendLimit
	}
	return nil
}

func (s *Store) ListCampaignRecipients(ctx context.Context, id int64, status string, limit, offset int) ([]CampaignRecipient, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var total int
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1 AND ($2='' OR status::text=$2)`, id, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.reader().Query(ctx, `SELECT person_id, email::text, first_name, status::text, COALESCE(ses_message_id,''), attempts,
		COALESCE(last_error,''), COALESCE(skip_reason,''), sent_at
		FROM comms.campaign_recipient WHERE campaign_id=$1 AND ($2='' OR status::text=$2)
		ORDER BY person_id LIMIT $3 OFFSET $4`, id, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []CampaignRecipient{}
	for rows.Next() {
		var r CampaignRecipient
		if err := rows.Scan(&r.PersonID, &r.Email, &r.FirstName, &r.Status, &r.SESMessageID, &r.Attempts, &r.LastError, &r.SkipReason, &r.SentAt); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

func (s *Store) RecipientByMessageID(ctx context.Context, msgID string) (int64, int64, string, bool, error) {
	var cid, pid int64
	var email string
	err := s.db.QueryRow(ctx, `SELECT campaign_id, person_id, email::text FROM comms.campaign_recipient WHERE ses_message_id=$1`, msgID).Scan(&cid, &pid, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, "", false, nil
	}
	return cid, pid, email, err == nil, err
}

func (s *Store) MarkRecipient(ctx context.Context, campaignID, personID int64, status, lastError string) error {
	_, err := s.db.Exec(ctx, `UPDATE comms.campaign_recipient
		SET status=$3::comms.recipient_status, last_error=NULLIF($4,''),
		    sent_at = CASE WHEN $3='sent' THEN now() ELSE sent_at END
		WHERE campaign_id=$1 AND person_id=$2`, campaignID, personID, status, lastError)
	return err
}

func (s *Store) AddUnsubscribe(ctx context.Context, email string, personID *int64, source string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO comms.unsubscribe (email, person_id, source) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`, email, personID, source)
	return err
}

func (s *Store) AddSuppressed(ctx context.Context, email, reason string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO comms.suppressed_email (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`, email, reason)
	return err
}

func (s *Store) RefreshCampaignCounters(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, `UPDATE comms.campaign c SET
		sent_count       = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status IN ('sent','delivered','bounced','complained')),
		delivered_count  = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='delivered'),
		bounced_count    = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='bounced'),
		complained_count = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='complained'),
		failed_count     = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='failed')
		WHERE c.id=$1`, id)
	return err
}
```

Corrección obligatoria en `CountCampaignsApprovedToday`: la precedencia `AND ... OR` está mal. Usar:
```go
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM comms.campaign
		WHERE status IN ('approved','sending','paused','done')
		  AND COALESCE(started_at, updated_at) >= date_trunc('day', now())`).Scan(&n)
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run TestCommsStore_CampaignLifecycle_Integration`
Expected: PASS. Si `shiftParams` rompe el SQL, imprimir `shifted` en el test y comparar placeholders `$2..$6`.

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/comms_store.go vp-engine/internal/payments/comms_store_integration_test.go
git commit -m "feat(comms): store de campañas, audiencia, destinatarios, bajas y supresión"
```

---

### Task 8: `comms_approval.go` — submit y decisión four-eyes

**Files:**
- Create: `vp-engine/internal/payments/comms_approval.go`
- Test: `vp-engine/internal/payments/comms_approval_integration_test.go`

**Interfaces:**
- Consumes: `Store.GetCampaign`, `SetCampaignStatus`, `EnqueueAudience`, `CountCampaignsApprovedToday` (Task 7); `seedAdmin` (existe en `plan_integration_test.go:13`).
- Produces:
  ```go
  var ErrSameApprover, ErrAdminPersonMissing error
  func (s *Store) SubmitCampaign(ctx, id int64, adminEmail, reason string) (Campaign, error)      // draft → pending_approval + approval_request
  func (s *Store) DecideCampaign(ctx, id int64, superEmail, decision, reason string, maxAudience, maxPerDay int) (Campaign, error) // approve|reject
  ```

- [ ] **Step 1: Test que falla**

```go
package payments

import (
	"context"
	"errors"
	"testing"

	"github.com/vicionpower/vp-engine/internal/comms"
)

func TestCommsApproval_FourEyes_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	seedAdmin(t, ctx, pool, "admin@x.com")
	seedAdmin(t, ctx, pool, "super@x.com")
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status)
		VALUES ('M','B','member@x.com','3000000000','active')`); err != nil {
		t.Fatal(err)
	}
	seg, _ := comms.ParseSegment([]byte(`{}`))
	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Cuerpo de prueba largo", seg)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.SubmitCampaign(ctx, c.ID, "admin@x.com", "corto"); err == nil {
		t.Fatal("reason < 10 chars should fail")
	}
	c, err = store.SubmitCampaign(ctx, c.ID, "admin@x.com", "comunicado mensual de septiembre")
	if err != nil || c.Status != "pending_approval" || c.ApprovalRequestID == nil {
		t.Fatalf("submit = %+v, %v", c, err)
	}

	if _, err := store.DecideCampaign(ctx, c.ID, "admin@x.com", "approve", "yo mismo", 150000, 3); !errors.Is(err, ErrSameApprover) {
		t.Fatalf("self-approval must fail, got %v", err)
	}
	c, err = store.DecideCampaign(ctx, c.ID, "super@x.com", "approve", "ok aprobado", 150000, 3)
	if err != nil || c.Status != "approved" || c.ApprovedBy != "super@x.com" || c.AudienceCount == nil || *c.AudienceCount != 1 {
		t.Fatalf("approve = %+v, %v", c, err)
	}
	var st string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM mlm.approval_request WHERE id=$1`, *c.ApprovalRequestID).Scan(&st); err != nil || st != "approved" {
		t.Fatalf("approval_request status = %q, %v", st, err)
	}

	// límite diario: la siguiente campaña no puede aprobarse con maxPerDay=1
	c2, _ := store.CreateCampaign(ctx, "admin@x.com", "Otro asunto", "Otro cuerpo largo", seg)
	c2, _ = store.SubmitCampaign(ctx, c2.ID, "admin@x.com", "segunda campaña del día")
	if _, err := store.DecideCampaign(ctx, c2.ID, "super@x.com", "approve", "ok", 150000, 1); !errors.Is(err, ErrDailyLimit) {
		t.Fatalf("expected ErrDailyLimit, got %v", err)
	}
	c2, err = store.DecideCampaign(ctx, c2.ID, "super@x.com", "reject", "no procede ahora", 150000, 3)
	if err != nil || c2.Status != "rejected" {
		t.Fatalf("reject = %+v, %v", c2, err)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run TestCommsApproval_FourEyes_Integration`
Expected: FAIL `undefined: ErrSameApprover`

- [ ] **Step 3: Implementación**

```go
package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/comms"
)

var (
	ErrSameApprover       = errors.New("same_approver")
	ErrAdminPersonMissing = errors.New("admin_person_missing")
)

func (s *Store) personIDByEmail(ctx context.Context, email string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM mlm.person WHERE email = $1 LIMIT 1`, strings.ToLower(strings.TrimSpace(email))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrAdminPersonMissing
	}
	return id, err
}

// SubmitCampaign: draft → pending_approval, creando la approval_request.
func (s *Store) SubmitCampaign(ctx context.Context, id int64, adminEmail, reason string) (Campaign, error) {
	reason = strings.TrimSpace(reason)
	if len(reason) < 10 {
		return Campaign{}, fmt.Errorf("reason_too_short")
	}
	c, err := s.GetCampaign(ctx, id)
	if err != nil {
		return Campaign{}, err
	}
	if c.Status != "draft" {
		return Campaign{}, ErrCampaignState
	}
	initiator, err := s.personIDByEmail(ctx, adminEmail)
	if err != nil {
		return Campaign{}, err
	}
	seg, err := comms.ParseSegment(c.Segment)
	if err != nil {
		return Campaign{}, err
	}
	prev, err := s.PreviewAudience(ctx, seg)
	if err != nil {
		return Campaign{}, err
	}
	payload, _ := json.Marshal(map[string]any{
		"campaign_id": c.ID, "subject": c.Subject, "audience_count": prev.Eligible, "segment": json.RawMessage(c.Segment),
	})
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Campaign{}, err
	}
	defer tx.Rollback(ctx)
	var arID int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.approval_request
		(operation_type, payload, requires_n_approvers, initiator_person_id, initiator_reason)
		VALUES ('comms_campaign', $1, 1, $2, $3) RETURNING id`, payload, initiator, reason).Scan(&arID); err != nil {
		return Campaign{}, fmt.Errorf("approval_request: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE comms.campaign SET status='pending_approval', approval_request_id=$2, audience_count=$3
		WHERE id=$1 AND status='draft'`, id, arID, prev.Eligible); err != nil {
		return Campaign{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Campaign{}, err
	}
	return s.GetCampaign(ctx, id)
}

// DecideCampaign: approve|reject por un super_admin distinto del creador.
// approve encola la audiencia (recalculada) y valida límites.
func (s *Store) DecideCampaign(ctx context.Context, id int64, superEmail, decision, reason string, maxAudience, maxPerDay int) (Campaign, error) {
	decision = strings.ToLower(strings.TrimSpace(decision))
	if decision != "approve" && decision != "reject" {
		return Campaign{}, fmt.Errorf("decision_invalid")
	}
	c, err := s.GetCampaign(ctx, id)
	if err != nil {
		return Campaign{}, err
	}
	if c.Status != "pending_approval" || c.ApprovalRequestID == nil {
		return Campaign{}, ErrCampaignState
	}
	if strings.EqualFold(c.CreatedBy, superEmail) {
		return Campaign{}, ErrSameApprover
	}
	approver, err := s.personIDByEmail(ctx, superEmail)
	if err != nil {
		return Campaign{}, err
	}
	if decision == "approve" {
		if maxPerDay > 0 {
			n, err := s.CountCampaignsApprovedToday(ctx)
			if err != nil {
				return Campaign{}, err
			}
			if n >= maxPerDay {
				return Campaign{}, ErrDailyLimit
			}
		}
		seg, err := comms.ParseSegment(c.Segment)
		if err != nil {
			return Campaign{}, err
		}
		if _, err := s.EnqueueAudience(ctx, id, seg, maxAudience); err != nil {
			return Campaign{}, err
		}
	}
	arStatus, cStatus := "approved", "approved"
	if decision == "reject" {
		arStatus, cStatus = "rejected", "rejected"
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Campaign{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE mlm.approval_request
		SET approver_1_person_id=$2, approver_1_decision=$3, approver_1_reason=$4, approver_1_at=now(), status=$5::mlm.approval_status
		WHERE id=$1 AND status='pending'`, *c.ApprovalRequestID, approver, decision, reason, arStatus); err != nil {
		return Campaign{}, fmt.Errorf("approval decide: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE comms.campaign SET status=$2::comms.campaign_status, approved_by=$3,
		finished_at = CASE WHEN $2='rejected' THEN now() ELSE NULL END
		WHERE id=$1 AND status='pending_approval'`, id, cStatus, strings.ToLower(superEmail)); err != nil {
		return Campaign{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Campaign{}, err
	}
	return s.GetCampaign(ctx, id)
}
```

Comprobar en `_meta/schema_governance.sql` que `mlm.approval_status` contiene `'approved'` y `'rejected'` (los usa `DecidePlanChange` en `plan.go:358-380`); si los nombres difieren, usar los mismos que allí.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run TestCommsApproval_FourEyes_Integration`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/comms_approval.go vp-engine/internal/payments/comms_approval_integration_test.go
git commit -m "feat(comms): solicitud y aprobación four-eyes de campañas sobre mlm.approval_request"
```

---

### Task 9: `comms_sender.go` — loop de envío

**Files:**
- Create: `vp-engine/internal/payments/comms_sender.go`
- Test: `vp-engine/internal/payments/comms_sender_integration_test.go`

**Interfaces:**
- Consumes: `EmailSender`, `HTMLEmail` (Task 6); `comms.Render`, `comms.SignUnsubscribe`, `comms.UnsubscribeURL`, `comms.RetryDelay`, `comms.IsTransientSESError`, `comms.MaxAttempts` (Tasks 3-5); Store (Task 7).
- Produces:
  ```go
  type CommsSenderConfig struct {
      RatePerSec        int
      BatchSize         int
      SESConfigSet      string
      UnsubscribeSecret []byte
      UnsubscribeBase   string
      ReplyTo           string        // "soporte@mindblisspower.com"
      UnsubscribeTTL    time.Duration // 180d
  }
  type CommsSender struct{ /* store, email EmailSender, cfg, log */ }
  func NewCommsSender(store *Store, email EmailSender, cfg CommsSenderConfig, log zerolog.Logger) *CommsSender
  func (cs *CommsSender) RunOnce(ctx) (processed int, err error) // procesa UN lote de la campaña activa; 0 si no hay trabajo
  func (cs *CommsSender) Loop(ctx)                                // RunOnce continuo; duerme 5s cuando no hay trabajo
  func (cs *CommsSender) SendTest(ctx, c Campaign, toEmail string) error // "[PRUEBA] " + subject, sin tocar recipients
  ```

- [ ] **Step 1: Test que falla**

```go
package payments

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type fakeAPIErr struct {
	code   string
	status int
}

func (e fakeAPIErr) Error() string       { return e.code }
func (e fakeAPIErr) ErrorCode() string   { return e.code }
func (e fakeAPIErr) HTTPStatusCode() int { return e.status }

type fakeEmailSender struct {
	mu    sync.Mutex
	sent  []HTMLEmail
	fails map[string]error // por email: error a devolver (una vez)
	n     int
}

func (f *fakeEmailSender) SendHTMLEmail(_ context.Context, m HTMLEmail) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.fails[m.To]; ok {
		delete(f.fails, m.To)
		return "", err
	}
	f.n++
	f.sent = append(f.sent, m)
	return "msg-" + m.To, nil
}

func approvedCampaign(t *testing.T, ctx context.Context, store *Store, emails []string) Campaign {
	t.Helper()
	for _, e := range emails {
		if _, err := store.db.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status)
			VALUES ('Ana','B',$1,'3000000000','active') ON CONFLICT DO NOTHING`, e); err != nil {
			t.Fatal(err)
		}
	}
	seg, _ := comms.ParseSegment([]byte(`{}`))
	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Hola **equipo**", seg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueAudience(ctx, c.ID, seg, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "approved", ""); err != nil {
		t.Fatal(err)
	}
	return c
}

func newTestSender(store *Store, f *fakeEmailSender) *CommsSender {
	return NewCommsSender(store, f, CommsSenderConfig{
		RatePerSec: 1000, BatchSize: 2, SESConfigSet: "entregas",
		UnsubscribeSecret: []byte("s"), UnsubscribeBase: "https://app.test/baja",
		ReplyTo: "soporte@x.com", UnsubscribeTTL: time.Hour,
	}, zerolog.Nop())
}

func TestCommsSender_SendsAllAndFinishes_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"a@x.com", "b@x.com", "c@x.com"})
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)

	total := 0
	for i := 0; i < 5; i++ {
		n, err := cs.RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		total += n
		if n == 0 {
			break
		}
	}
	if total != 3 || len(f.sent) != 3 {
		t.Fatalf("sent = %d / %d", total, len(f.sent))
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.Status != "done" || got.SentCount != 3 || got.FinishedAt == nil {
		t.Fatalf("campaign = %+v", got)
	}
	m := f.sent[0]
	if m.ConfigSet != "entregas" || m.ReplyTo != "soporte@x.com" || m.UnsubscribeURL == "" || m.Subject != "Asunto largo" {
		t.Fatalf("mail = %+v", m)
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "sent", 10, 0)
	if len(recs) != 3 || recs[0].SESMessageID == "" {
		t.Fatalf("recipients = %+v", recs)
	}
}

func TestCommsSender_RetryTransientFailPermanentPauseOnDenied_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"t@x.com", "p@x.com"})
	f := &fakeEmailSender{fails: map[string]error{
		"t@x.com": fakeAPIErr{"TooManyRequestsException", 429},
		"p@x.com": fakeAPIErr{"BadRequestException", 400},
	}}
	cs := newTestSender(store, f)
	if _, err := cs.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "", 10, 0)
	byEmail := map[string]CampaignRecipient{}
	for _, r := range recs {
		byEmail[r.Email] = r
	}
	if byEmail["t@x.com"].Status != "queued" || byEmail["t@x.com"].Attempts != 1 {
		t.Fatalf("transient = %+v", byEmail["t@x.com"])
	}
	if byEmail["p@x.com"].Status != "failed" {
		t.Fatalf("permanent = %+v", byEmail["p@x.com"])
	}
	// el reintento aún no vence (next_attempt_at en 1 min) ⇒ RunOnce no envía nada
	if n, _ := cs.RunOnce(ctx); n != 0 {
		t.Fatalf("should wait for backoff, sent %d", n)
	}
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET next_attempt_at = now() - interval '1s' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := cs.RunOnce(ctx); n != 1 {
		t.Fatalf("retry should send 1, sent %d", n)
	}

	// AccessDenied pausa la campaña
	c2 := approvedCampaign(t, ctx, store, []string{"d@x.com"})
	f2 := &fakeEmailSender{fails: map[string]error{"d@x.com": fakeAPIErr{"AccessDeniedException", 403}}}
	cs2 := newTestSender(store, f2)
	_, _ = cs2.RunOnce(ctx)
	got, _ := store.GetCampaign(ctx, c2.ID)
	if got.Status != "paused" || got.PauseReason == "" {
		t.Fatalf("expected paused, got %+v", got)
	}
}

func TestCommsSender_StaleSendingIsFailedNotResent_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"s@x.com"})
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sending', updated_at = now() - interval '20 min' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)
	_, _ = cs.RunOnce(ctx)
	_, _ = cs.RunOnce(ctx)
	if len(f.sent) != 0 {
		t.Fatal("stale row must not be resent")
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "failed", 10, 0)
	if len(recs) != 1 || recs[0].LastError != "stale" {
		t.Fatalf("recs = %+v", recs)
	}
}

func TestCommsSender_SendTest_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	seg, _ := comms.ParseSegment([]byte(`{}`))
	c, _ := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Cuerpo de prueba largo", seg)
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)
	if err := cs.SendTest(ctx, c, "admin@x.com"); err != nil {
		t.Fatal(err)
	}
	if len(f.sent) != 1 || f.sent[0].Subject != "[PRUEBA] Asunto largo" || f.sent[0].To != "admin@x.com" {
		t.Fatalf("test mail = %+v", f.sent)
	}
	if _, err := errors.Is(nil, nil), error(nil); err != nil {
		t.Fatal(err)
	}
}
```

(Quitar la última sentencia sin sentido de `TestCommsSender_SendTest_Integration` antes de commitear; queda solo la verificación de `f.sent`.)

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run 'TestCommsSender_'`
Expected: FAIL `undefined: NewCommsSender`

- [ ] **Step 3: Implementación**

```go
package payments

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type CommsSenderConfig struct {
	RatePerSec        int
	BatchSize         int
	SESConfigSet      string
	UnsubscribeSecret []byte
	UnsubscribeBase   string
	ReplyTo           string
	UnsubscribeTTL    time.Duration
}

type CommsSender struct {
	store *Store
	email EmailSender
	cfg   CommsSenderConfig
	log   zerolog.Logger
}

func NewCommsSender(store *Store, email EmailSender, cfg CommsSenderConfig, log zerolog.Logger) *CommsSender {
	if cfg.RatePerSec <= 0 {
		cfg.RatePerSec = 10
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.UnsubscribeTTL <= 0 {
		cfg.UnsubscribeTTL = 180 * 24 * time.Hour
	}
	return &CommsSender{store: store, email: email, cfg: cfg, log: log}
}

func (cs *CommsSender) Loop(ctx context.Context) {
	cs.log.Info().Int("rate", cs.cfg.RatePerSec).Int("batch", cs.cfg.BatchSize).Msg("comms sender started")
	for {
		n, err := cs.RunOnce(ctx)
		if err != nil {
			cs.log.Error().Err(err).Msg("comms sender RunOnce failed (non-fatal)")
		}
		wait := time.Second
		if n == 0 {
			wait = 5 * time.Second
		}
		select {
		case <-ctx.Done():
			cs.log.Info().Msg("comms sender stopped")
			return
		case <-time.After(wait):
		}
	}
}

// RunOnce: 1) filas 'sending' atascadas → failed(stale); 2) toma la campaña
// activa (sending, o approved más antigua); 3) envía un lote respetando el ritmo;
// 4) cierra la campaña si no queda trabajo.
func (cs *CommsSender) RunOnce(ctx context.Context) (int, error) {
	if _, err := cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='failed', last_error='stale'
		WHERE status='sending' AND updated_at < now() - interval '10 minutes'`); err != nil {
		return 0, fmt.Errorf("stale sweep: %w", err)
	}
	var id int64
	err := cs.store.db.QueryRow(ctx, `UPDATE comms.campaign SET status='sending', started_at=COALESCE(started_at, now())
		WHERE id = (SELECT id FROM comms.campaign WHERE status IN ('sending','approved')
		            ORDER BY (status='sending') DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id`).Scan(&id)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return 0, nil
		}
		return 0, fmt.Errorf("claim campaign: %w", err)
	}
	c, err := cs.store.GetCampaign(ctx, id)
	if err != nil {
		return 0, err
	}
	rows, err := cs.store.db.Query(ctx, `SELECT person_id, email::text, first_name FROM comms.campaign_recipient
		WHERE campaign_id=$1 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
		ORDER BY person_id LIMIT $2`, id, cs.cfg.BatchSize)
	if err != nil {
		return 0, err
	}
	type rec struct {
		pid   int64
		email string
		name  string
	}
	batch := []rec{}
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.pid, &r.email, &r.name); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if len(batch) == 0 {
		return 0, cs.maybeFinish(ctx, id)
	}
	interval := time.Second / time.Duration(cs.cfg.RatePerSec)
	sent := 0
	for _, r := range batch {
		// re-chequear pausa/cancelación entre envíos
		var st string
		if err := cs.store.db.QueryRow(ctx, `SELECT status::text FROM comms.campaign WHERE id=$1`, id).Scan(&st); err != nil || st != "sending" {
			return sent, err
		}
		tag, err := cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sending', attempts=attempts+1
			WHERE campaign_id=$1 AND person_id=$2 AND status='queued'`, id, r.pid)
		if err != nil || tag.RowsAffected() == 0 {
			continue
		}
		tok := comms.SignUnsubscribe(cs.cfg.UnsubscribeSecret, r.pid, time.Now().Add(cs.cfg.UnsubscribeTTL))
		rendered, err := comms.Render(comms.RenderInput{Subject: c.Subject, BodyMarkdown: c.BodyMarkdown, FirstName: r.name,
			UnsubscribeURL: comms.UnsubscribeURL(cs.cfg.UnsubscribeBase, tok)})
		if err != nil {
			_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", "render: "+err.Error())
			continue
		}
		sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		msgID, err := cs.email.SendHTMLEmail(sendCtx, HTMLEmail{To: r.email, Subject: rendered.Subject, HTML: rendered.HTML, Text: rendered.Text,
			ReplyTo: cs.cfg.ReplyTo, ConfigSet: cs.cfg.SESConfigSet, UnsubscribeURL: comms.UnsubscribeURL(cs.cfg.UnsubscribeBase, tok)})
		cancel()
		switch {
		case err == nil:
			_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id=$3, sent_at=now(), last_error=NULL
				WHERE campaign_id=$1 AND person_id=$2`, id, r.pid, msgID)
			sent++
		case isAccessDenied(err):
			_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='queued', attempts=attempts-1 WHERE campaign_id=$1 AND person_id=$2`, id, r.pid)
			_ = cs.store.SetCampaignStatus(ctx, id, []string{"sending"}, "paused", "ses_access_denied: "+err.Error())
			cs.store.cache.PublishEvent(ctx, "comms.campaign_paused", map[string]any{"campaign_id": id, "reason": "ses_access_denied"})
			cs.log.Error().Err(err).Int64("campaign", id).Msg("comms: SES access denied, campaign paused")
			return sent, nil
		case comms.IsTransientSESError(err):
			var attempts int
			_ = cs.store.db.QueryRow(ctx, `SELECT attempts FROM comms.campaign_recipient WHERE campaign_id=$1 AND person_id=$2`, id, r.pid).Scan(&attempts)
			if d := comms.RetryDelay(attempts); d > 0 && attempts <= comms.MaxAttempts {
				_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='queued', next_attempt_at=now()+$3::interval, last_error=$4
					WHERE campaign_id=$1 AND person_id=$2`, id, r.pid, d.String(), truncErr(err))
			} else {
				_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", truncErr(err))
			}
		default:
			_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", truncErr(err))
		}
		select {
		case <-ctx.Done():
			return sent, ctx.Err()
		case <-time.After(interval):
		}
	}
	if err := cs.store.RefreshCampaignCounters(ctx, id); err != nil {
		return sent, err
	}
	return sent, cs.maybeFinish(ctx, id)
}

func (cs *CommsSender) maybeFinish(ctx context.Context, id int64) error {
	var pending int
	if err := cs.store.db.QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1 AND status IN ('queued','sending')`, id).Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		return nil
	}
	if err := cs.store.RefreshCampaignCounters(ctx, id); err != nil {
		return err
	}
	if err := cs.store.SetCampaignStatus(ctx, id, []string{"sending"}, "done", ""); err != nil && !errors.Is(err, ErrCampaignState) {
		return err
	}
	cs.log.Info().Int64("campaign", id).Msg("comms: campaign done")
	return nil
}

// SendTest envía la campaña renderizada al email del admin, sin tocar recipients.
func (cs *CommsSender) SendTest(ctx context.Context, c Campaign, toEmail string) error {
	tok := comms.SignUnsubscribe(cs.cfg.UnsubscribeSecret, 0+1, time.Now().Add(time.Hour)) // person 1 = placeholder; la baja de prueba no aplica
	url := comms.UnsubscribeURL(cs.cfg.UnsubscribeBase, tok)
	rendered, err := comms.Render(comms.RenderInput{Subject: c.Subject, BodyMarkdown: c.BodyMarkdown, FirstName: "", UnsubscribeURL: url})
	if err != nil {
		return err
	}
	_, err = cs.email.SendHTMLEmail(ctx, HTMLEmail{To: toEmail, Subject: "[PRUEBA] " + rendered.Subject, HTML: rendered.HTML, Text: rendered.Text,
		ReplyTo: cs.cfg.ReplyTo, ConfigSet: cs.cfg.SESConfigSet})
	return err
}

func isAccessDenied(err error) bool {
	var c interface{ ErrorCode() string }
	return errors.As(err, &c) && c.ErrorCode() == "AccessDeniedException"
}

func truncErr(err error) string {
	s := err.Error()
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
```

Notas para el implementador:
- `cs.store.cache` puede ser nil en tests: `PublishEvent` ya es no-op con receptor nil (verificar en `cache.go:89`; si no, guardar con `if cs.store.cache != nil`).
- El `ORDER BY (status='sending') DESC` prioriza retomar una campaña en curso tras un reinicio.
- En `SendTest`, el token de baja usa `person_id=1` solo para que el pie renderice; documentar en el texto del correo de prueba no es necesario.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run 'TestCommsSender_' -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/comms_sender.go vp-engine/internal/payments/comms_sender_integration_test.go
git commit -m "feat(comms): sender de campañas con throttling, reintentos, pausa por AccessDenied y cierre"
```

---

### Task 10: `comms_events.go` — consumer SQS de eventos SES

**Files:**
- Create: `vp-engine/internal/payments/comms_events.go`
- Test: `vp-engine/internal/payments/comms_events_integration_test.go`
- Modify: `vp-engine/go.mod` (`go get github.com/aws/aws-sdk-go-v2/service/sqs@latest`)

**Interfaces:**
- Consumes: `comms.ParseSESEvent` (Task 5); `Store.RecipientByMessageID`, `MarkRecipient`, `AddSuppressed`, `AddUnsubscribe`, `RefreshCampaignCounters`, `SetCampaignStatus` (Task 7).
- Produces:
  ```go
  type QueueMessage struct{ ID, ReceiptHandle, Body string }
  type QueueClient interface {
      Receive(ctx, max int, waitSec int) ([]QueueMessage, error)
      Delete(ctx, receiptHandle string) error
  }
  func NewSQSQueueClient(ctx, queueURL string) (QueueClient, error)   // sqs.NewFromConfig(LoadDefaultConfig)
  type CommsEventConsumer struct{ /* store, q QueueClient, log */ }
  func NewCommsEventConsumer(store *Store, q QueueClient, log zerolog.Logger) *CommsEventConsumer
  func (ec *CommsEventConsumer) ProcessBody(ctx, body []byte) (matched bool, err error) // aplica un evento; false si no es de campaña
  func (ec *CommsEventConsumer) RunOnce(ctx) (processed int, err error)
  func (ec *CommsEventConsumer) Loop(ctx)
  ```
- Regla de auto-pausa: tras aplicar un Bounce, si la campaña tiene `sent_count >= 1000` y `bounced_count*100 > sent_count*5` y está en `sending` → `paused` con `pause_reason='bounce_rate'` + evento `comms.campaign_paused`.

- [ ] **Step 1: Test que falla**

```go
package payments

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

type fakeQueue struct {
	msgs    []QueueMessage
	deleted []string
}

func (f *fakeQueue) Receive(_ context.Context, max, _ int) ([]QueueMessage, error) {
	if len(f.msgs) == 0 {
		return nil, nil
	}
	n := max
	if n > len(f.msgs) {
		n = len(f.msgs)
	}
	out := f.msgs[:n]
	f.msgs = f.msgs[n:]
	return out, nil
}
func (f *fakeQueue) Delete(_ context.Context, rh string) error { f.deleted = append(f.deleted, rh); return nil }

func TestCommsEvents_ApplyDeliveryBounceComplaint_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"d@x.com", "b@x.com", "c@x.com"})
	for _, r := range []struct{ email, msg string }{{"d@x.com", "m-d"}, {"b@x.com", "m-b"}, {"c@x.com", "m-c"}} {
		if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id=$3 WHERE campaign_id=$1 AND email=$2`, c.ID, r.email, r.msg); err != nil {
			t.Fatal(err)
		}
	}
	q := &fakeQueue{msgs: []QueueMessage{
		{ID: "1", ReceiptHandle: "r1", Body: `{"eventType":"Delivery","mail":{"messageId":"m-d"}}`},
		{ID: "2", ReceiptHandle: "r2", Body: `{"eventType":"Bounce","mail":{"messageId":"m-b"},"bounce":{"bounceType":"Permanent","bouncedRecipients":[{"diagnosticCode":"550"}]}}`},
		{ID: "3", ReceiptHandle: "r3", Body: `{"eventType":"Complaint","mail":{"messageId":"m-c"},"complaint":{"complaintFeedbackType":"abuse"}}`},
		{ID: "4", ReceiptHandle: "r4", Body: `{"eventType":"Delivery","mail":{"messageId":"otp-not-ours"}}`},
		{ID: "5", ReceiptHandle: "r5", Body: `garbage`},
	}}
	ec := NewCommsEventConsumer(store, q, zerolog.Nop())
	n, err := ec.RunOnce(ctx)
	if err != nil || n != 5 {
		t.Fatalf("processed = %d, %v", n, err)
	}
	if len(q.deleted) != 5 {
		t.Fatalf("all messages must be deleted (incl. unmatched/garbage), got %d", len(q.deleted))
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "", 10, 0)
	st := map[string]string{}
	for _, r := range recs {
		st[r.Email] = r.Status
	}
	if st["d@x.com"] != "delivered" || st["b@x.com"] != "bounced" || st["c@x.com"] != "complained" {
		t.Fatalf("statuses = %v", st)
	}
	var supp, unsub int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM comms.suppressed_email WHERE email='b@x.com'`).Scan(&supp)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM comms.unsubscribe WHERE email='c@x.com' AND source='complaint'`).Scan(&unsub)
	if supp != 1 || unsub != 1 {
		t.Fatalf("suppressed=%d unsubscribed=%d", supp, unsub)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.DeliveredCount != 1 || got.BouncedCount != 1 || got.ComplainedCount != 1 {
		t.Fatalf("counters = %+v", got)
	}
}

func TestCommsEvents_AutoPauseOnBounceRate_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"z@x.com"})
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign SET status='sending', sent_count=1000, bounced_count=60 WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id='m-z' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	ec := NewCommsEventConsumer(store, &fakeQueue{}, zerolog.Nop())
	// RefreshCampaignCounters recalcula desde recipients (1 sent, 1 bounced) ⇒ simulamos
	// la regla con contadores ya altos: el consumer debe evaluar ANTES de refrescar.
	matched, err := ec.ProcessBody(ctx, []byte(`{"eventType":"Bounce","mail":{"messageId":"m-z"},"bounce":{"bounceType":"Permanent"}}`))
	if err != nil || !matched {
		t.Fatalf("matched=%v err=%v", matched, err)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.Status != "paused" || got.PauseReason != "bounce_rate" {
		t.Fatalf("expected paused by bounce_rate, got %+v", got)
	}
}
```

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run 'TestCommsEvents_'`
Expected: FAIL `undefined: QueueMessage`

- [ ] **Step 3: Implementación**

```go
package payments

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type QueueMessage struct{ ID, ReceiptHandle, Body string }

type QueueClient interface {
	Receive(ctx context.Context, max int, waitSec int) ([]QueueMessage, error)
	Delete(ctx context.Context, receiptHandle string) error
}

type sqsQueueClient struct {
	c   *sqs.Client
	url string
}

func NewSQSQueueClient(ctx context.Context, queueURL string) (QueueClient, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return &sqsQueueClient{c: sqs.NewFromConfig(cfg), url: queueURL}, nil
}

func (q *sqsQueueClient) Receive(ctx context.Context, max, waitSec int) ([]QueueMessage, error) {
	out, err := q.c.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: aws.String(q.url), MaxNumberOfMessages: int32(max), WaitTimeSeconds: int32(waitSec), VisibilityTimeout: 60,
	})
	if err != nil {
		return nil, err
	}
	msgs := make([]QueueMessage, 0, len(out.Messages))
	for _, m := range out.Messages {
		msgs = append(msgs, QueueMessage{ID: aws.ToString(m.MessageId), ReceiptHandle: aws.ToString(m.ReceiptHandle), Body: aws.ToString(m.Body)})
	}
	return msgs, nil
}

func (q *sqsQueueClient) Delete(ctx context.Context, rh string) error {
	_, err := q.c.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(q.url), ReceiptHandle: aws.String(rh)})
	return err
}

type CommsEventConsumer struct {
	store *Store
	q     QueueClient
	log   zerolog.Logger
}

func NewCommsEventConsumer(store *Store, q QueueClient, log zerolog.Logger) *CommsEventConsumer {
	return &CommsEventConsumer{store: store, q: q, log: log}
}

func (ec *CommsEventConsumer) Loop(ctx context.Context) {
	ec.log.Info().Msg("comms event consumer started")
	for {
		if _, err := ec.RunOnce(ctx); err != nil {
			ec.log.Error().Err(err).Msg("comms event consumer RunOnce failed (non-fatal)")
			select {
			case <-ctx.Done():
				return
			case <-time.After(10 * time.Second):
			}
		}
		if ctx.Err() != nil {
			ec.log.Info().Msg("comms event consumer stopped")
			return
		}
	}
}

// RunOnce: long-poll (20 s) de hasta 10 mensajes; cada mensaje se borra siempre
// (los no relacionados con campañas o corruptos se descartan sin reintento).
func (ec *CommsEventConsumer) RunOnce(ctx context.Context) (int, error) {
	msgs, err := ec.q.Receive(ctx, 10, 20)
	if err != nil {
		return 0, fmt.Errorf("sqs receive: %w", err)
	}
	for _, m := range msgs {
		if _, perr := ec.ProcessBody(ctx, []byte(m.Body)); perr != nil {
			ec.log.Warn().Err(perr).Str("msg", m.ID).Msg("comms event skipped")
		}
		if derr := ec.q.Delete(ctx, m.ReceiptHandle); derr != nil {
			ec.log.Warn().Err(derr).Str("msg", m.ID).Msg("sqs delete failed")
		}
	}
	return len(msgs), nil
}

func (ec *CommsEventConsumer) ProcessBody(ctx context.Context, body []byte) (bool, error) {
	ev, err := comms.ParseSESEvent(body)
	if err != nil {
		return false, err
	}
	cid, pid, email, found, err := ec.store.RecipientByMessageID(ctx, ev.MessageID)
	if err != nil || !found {
		return false, err
	}
	switch ev.Type {
	case "Delivery":
		err = ec.store.MarkRecipient(ctx, cid, pid, "delivered", "")
	case "Bounce":
		if ev.Permanent {
			if err = ec.store.MarkRecipient(ctx, cid, pid, "bounced", ev.Diagnostic); err == nil {
				err = ec.store.AddSuppressed(ctx, email, "bounce_permanent")
			}
		} else {
			err = ec.store.MarkRecipient(ctx, cid, pid, "sent", "bounce_transient: "+ev.Diagnostic)
		}
	case "Complaint":
		if err = ec.store.MarkRecipient(ctx, cid, pid, "complained", ev.Diagnostic); err == nil {
			err = ec.store.AddUnsubscribe(ctx, email, &pid, "complaint")
		}
	default:
		return true, nil
	}
	if err != nil {
		return true, err
	}
	if ev.Type == "Bounce" {
		if perr := ec.maybePauseForBounceRate(ctx, cid); perr != nil {
			return true, perr
		}
	}
	return true, ec.store.RefreshCampaignCounters(ctx, cid)
}

func (ec *CommsEventConsumer) maybePauseForBounceRate(ctx context.Context, cid int64) error {
	c, err := ec.store.GetCampaign(ctx, cid)
	if err != nil {
		return err
	}
	// +1 por el rebote que acabamos de aplicar (los contadores aún no se refrescan)
	bounced := c.BouncedCount + 1
	if c.Status == "sending" && c.SentCount >= 1000 && bounced*100 > c.SentCount*5 {
		if err := ec.store.SetCampaignStatus(ctx, cid, []string{"sending"}, "paused", "bounce_rate"); err != nil {
			return err
		}
		ec.store.cache.PublishEvent(ctx, "comms.campaign_paused", map[string]any{"campaign_id": cid, "reason": "bounce_rate"})
		ec.log.Warn().Int64("campaign", cid).Int("sent", c.SentCount).Int("bounced", bounced).Msg("comms: campaign paused by bounce rate")
	}
	return nil
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `go get github.com/aws/aws-sdk-go-v2/service/sqs@latest && go mod tidy && go test ./internal/payments/ -count=1 -run 'TestCommsEvents_' -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add vp-engine/go.mod vp-engine/go.sum vp-engine/internal/payments/comms_events.go vp-engine/internal/payments/comms_events_integration_test.go
git commit -m "feat(comms): consumer SQS de eventos SES (entregas, rebotes, quejas, auto-pausa)"
```

---

### Task 11: `comms_http.go` — handlers y rutas

**Files:**
- Create: `vp-engine/internal/payments/comms_http.go`
- Modify: `vp-engine/internal/payments/http.go` (`Routes()`, junto a la línea 214 `mux.HandleFunc("/api/admin/email", ...)`), `Handler` struct (campos nuevos) y `NewHandler` no cambia: se añade `func (h *Handler) SetComms(sender *CommsSender, maxAudience, maxPerDay, maxTestSends int, unsubSecret []byte)`.
- Test: `vp-engine/internal/payments/comms_http_integration_test.go`

**Interfaces:**
- Consumes: Tasks 7-9; `requireAdmin` (`http.go:781`), `requireSuperAdmin` (`admin_manage.go:61`), `svcAuth`, `writeJSON`, `writeErr`; `comms.VerifyUnsubscribe`.
- Produces rutas (todas `email` en query para identidad, como el resto del panel):

| Método | Ruta | Auth | Body / Query | Respuesta |
|---|---|---|---|---|
| GET | `/api/admin/comms/campaigns` | admin | `status,limit,offset` | `{items:[Campaign], total}` |
| POST | `/api/admin/comms/campaigns` | admin | `{subject, body_markdown, segment}` | `Campaign` (201) |
| GET | `/api/admin/comms/campaign` | admin | `id` | `Campaign` |
| PUT | `/api/admin/comms/campaign` | admin | `{id, subject, body_markdown, segment}` | `Campaign` |
| POST | `/api/admin/comms/campaign/preview` | admin | `{id}` o `{subject, body_markdown, segment}` | `{audience: AudiencePreview, html}` |
| POST | `/api/admin/comms/campaign/test` | admin | `{id}` | `{sent:true, to}` |
| POST | `/api/admin/comms/campaign/submit` | admin | `{id, reason}` | `Campaign` |
| POST | `/api/admin/comms/campaign/decide` | super_admin | `{id, decision, reason}` | `Campaign` |
| POST | `/api/admin/comms/campaign/control` | super_admin | `{id, action: pause\|resume\|cancel}` | `Campaign` |
| GET | `/api/admin/comms/campaign/recipients` | admin | `id,status,limit,offset` | `{items, total}` |
| POST | `/api/comms/unsubscribe` | svcAuth | `{token}` | `{ok:true}` / 400 `invalid_token` / 410 `expired_token` |

Errores de dominio → códigos: `campaign_not_found` 404, `campaign_invalid_state` 409, `same_approver` 403, `audience_too_large` 422, `daily_campaign_limit` 429, `test_send_limit` 429, `admin_person_missing` 422, `reason_too_short` 400.

- [ ] **Step 1: Test que falla** (integración: `requireAdmin` consulta `mlm.person.is_admin`)

```go
package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

func commsTestHandler(t *testing.T, ctx context.Context, store *Store) (*Handler, *fakeEmailSender) {
	t.Helper()
	seedAdmin(t, ctx, store.db, "admin@x.com")
	seedAdmin(t, ctx, store.db, "super@x.com")
	h := NewHandler(store, nil, "svc-token", []string{"admin@x.com", "super@x.com"}, 0, zerolog.Nop())
	h.superAdminEmails = []string{"super@x.com"}
	f := &fakeEmailSender{}
	h.SetComms(newTestSender(store, f), 150000, 3, 5, []byte("unsub-secret"))
	return h, f
}

func doJSON(t *testing.T, h http.Handler, method, path, email string, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	sep := "?"
	if bytes.ContainsRune([]byte(path), '?') {
		sep = "&"
	}
	req := httptest.NewRequest(method, path+sep+"email="+email, &buf)
	req.Header.Set("X-VP-Service-Token", "svc-token")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	out := map[string]any{}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func TestCommsHTTP_FullFlow_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	h, f := commsTestHandler(t, ctx, store)
	routes := h.Routes()
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status) VALUES ('M','B','m@x.com','3000000000','active')`); err != nil {
		t.Fatal(err)
	}

	code, out := doJSON(t, routes, "POST", "/api/admin/comms/campaigns", "admin@x.com",
		map[string]any{"subject": "Asunto largo", "body_markdown": "Cuerpo de prueba largo", "segment": map[string]any{"status": []string{"active"}}})
	if code != 201 {
		t.Fatalf("create = %d %v", code, out)
	}
	id := int64(out["id"].(float64))

	code, out = doJSON(t, routes, "POST", "/api/admin/comms/campaign/preview", "admin@x.com", map[string]any{"id": id})
	if code != 200 || out["audience"].(map[string]any)["eligible"].(float64) != 1 || out["html"] == "" {
		t.Fatalf("preview = %d %v", code, out)
	}

	code, _ = doJSON(t, routes, "POST", "/api/admin/comms/campaign/test", "admin@x.com", map[string]any{"id": id})
	if code != 200 || len(f.sent) != 1 || f.sent[0].To != "admin@x.com" {
		t.Fatalf("test send = %d, sent=%d", code, len(f.sent))
	}

	code, _ = doJSON(t, routes, "POST", "/api/admin/comms/campaign/submit", "admin@x.com", map[string]any{"id": id, "reason": "comunicado de prueba mensual"})
	if code != 200 {
		t.Fatalf("submit = %d", code)
	}
	// admin (no super) no puede decidir
	code, _ = doJSON(t, routes, "POST", "/api/admin/comms/campaign/decide", "admin@x.com", map[string]any{"id": id, "decision": "approve", "reason": "ok"})
	if code != 403 {
		t.Fatalf("admin decide = %d, want 403", code)
	}
	code, out = doJSON(t, routes, "POST", "/api/admin/comms/campaign/decide", "super@x.com", map[string]any{"id": id, "decision": "approve", "reason": "aprobado"})
	if code != 200 || out["status"] != "approved" {
		t.Fatalf("decide = %d %v", code, out)
	}
	code, out = doJSON(t, routes, "POST", "/api/admin/comms/campaign/control", "super@x.com", map[string]any{"id": id, "action": "pause"})
	if code != 200 || out["status"] != "paused" {
		t.Fatalf("pause = %d %v", code, out)
	}
	code, out = doJSON(t, routes, "GET", "/api/admin/comms/campaign/recipients?id="+itoa(id), "admin@x.com", nil)
	if code != 200 || out["total"].(float64) != 1 {
		t.Fatalf("recipients = %d %v", code, out)
	}
	code, out = doJSON(t, routes, "GET", "/api/admin/comms/campaigns?status=paused", "admin@x.com", nil)
	if code != 200 || out["total"].(float64) != 1 {
		t.Fatalf("list = %d %v", code, out)
	}
}

func TestCommsHTTP_Unsubscribe_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	h, _ := commsTestHandler(t, ctx, store)
	routes := h.Routes()
	var pid int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status) VALUES ('M','B','u@x.com','3000000000','active') RETURNING id`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	tok := comms.SignUnsubscribe([]byte("unsub-secret"), pid, time.Now().Add(time.Hour))
	req := httptest.NewRequest("POST", "/api/comms/unsubscribe", bytes.NewBufferString(`{"token":"`+tok+`"}`))
	req.Header.Set("X-VP-Service-Token", "svc-token")
	rr := httptest.NewRecorder()
	routes.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("unsubscribe = %d %s", rr.Code, rr.Body.String())
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM comms.unsubscribe WHERE email='u@x.com' AND person_id=$1`, pid).Scan(&n)
	if n != 1 {
		t.Fatal("unsubscribe row missing")
	}
	req = httptest.NewRequest("POST", "/api/comms/unsubscribe", bytes.NewBufferString(`{"token":"bad"}`))
	req.Header.Set("X-VP-Service-Token", "svc-token")
	rr = httptest.NewRecorder()
	routes.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("bad token = %d", rr.Code)
	}
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }
```

Añadir a los imports del test: `"strconv"`, `"time"`, `"github.com/vicionpower/vp-engine/internal/comms"`.

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run 'TestCommsHTTP_'`
Expected: FAIL `h.SetComms undefined`

- [ ] **Step 3: Implementación**

En `http.go`, dentro de `type Handler struct` añadir:
```go
	comms struct {
		sender       *CommsSender
		maxAudience  int
		maxPerDay    int
		maxTestSends int
		unsubSecret  []byte
	}
```
y en `Routes()`, después de `mux.HandleFunc("/api/admin/email", h.handleAdminEmail)`:
```go
	mux.HandleFunc("/api/admin/comms/campaigns", h.handleCommsCampaigns)
	mux.HandleFunc("/api/admin/comms/campaign", h.handleCommsCampaign)
	mux.HandleFunc("/api/admin/comms/campaign/preview", h.handleCommsPreview)
	mux.HandleFunc("/api/admin/comms/campaign/test", h.handleCommsTest)
	mux.HandleFunc("/api/admin/comms/campaign/submit", h.handleCommsSubmit)
	mux.HandleFunc("/api/admin/comms/campaign/decide", h.handleCommsDecide)
	mux.HandleFunc("/api/admin/comms/campaign/control", h.handleCommsControl)
	mux.HandleFunc("/api/admin/comms/campaign/recipients", h.handleCommsRecipients)
	mux.HandleFunc("/api/comms/unsubscribe", h.handleCommsUnsubscribe)
```

`comms_http.go`:
```go
package payments

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vicionpower/vp-engine/internal/comms"
)

func (h *Handler) SetComms(sender *CommsSender, maxAudience, maxPerDay, maxTestSends int, unsubSecret []byte) {
	h.comms.sender = sender
	h.comms.maxAudience = maxAudience
	h.comms.maxPerDay = maxPerDay
	h.comms.maxTestSends = maxTestSends
	h.comms.unsubSecret = unsubSecret
}

func (h *Handler) commsReady(w http.ResponseWriter) bool {
	if h.comms.sender == nil {
		writeErr(w, http.StatusServiceUnavailable, "comms_disabled")
		return false
	}
	return true
}

func writeCommsErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrCampaignNotFound):
		writeErr(w, http.StatusNotFound, "campaign_not_found")
	case errors.Is(err, ErrCampaignState):
		writeErr(w, http.StatusConflict, "campaign_invalid_state")
	case errors.Is(err, ErrSameApprover):
		writeErr(w, http.StatusForbidden, "same_approver")
	case errors.Is(err, ErrAudienceTooLarge):
		writeErr(w, http.StatusUnprocessableEntity, "audience_too_large")
	case errors.Is(err, ErrDailyLimit):
		writeErr(w, http.StatusTooManyRequests, "daily_campaign_limit")
	case errors.Is(err, ErrTestSendLimit):
		writeErr(w, http.StatusTooManyRequests, "test_send_limit")
	case errors.Is(err, ErrAdminPersonMissing):
		writeErr(w, http.StatusUnprocessableEntity, "admin_person_missing")
	case err != nil && (err.Error() == "reason_too_short" || err.Error() == "decision_invalid"):
		writeErr(w, http.StatusBadRequest, err.Error())
	case err != nil && strings.HasPrefix(err.Error(), "segment "):
		writeErr(w, http.StatusBadRequest, "segment_invalid")
	default:
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}

type campaignBody struct {
	ID           int64           `json:"id"`
	Subject      string          `json:"subject"`
	BodyMarkdown string          `json:"body_markdown"`
	Segment      json.RawMessage `json:"segment"`
	Reason       string          `json:"reason"`
	Decision     string          `json:"decision"`
	Action       string          `json:"action"`
	Token        string          `json:"token"`
}

func readCampaignBody(r *http.Request) (campaignBody, bool) {
	var b campaignBody
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64<<10)).Decode(&b); err != nil {
		return b, false
	}
	b.Subject = strings.TrimSpace(b.Subject)
	b.BodyMarkdown = strings.TrimSpace(b.BodyMarkdown)
	return b, true
}

func validCampaignText(subject, body string) bool {
	return len(subject) >= 3 && len(subject) <= 150 && len(body) >= 10 && len(body) <= 20000
}

// GET (lista) / POST (crear) /api/admin/comms/campaigns
func (h *Handler) handleCommsCampaigns(w http.ResponseWriter, r *http.Request) {
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		items, total, err := h.store.ListCampaigns(r.Context(), q.Get("status"), limit, offset)
		if err != nil {
			h.log.Error().Err(err).Msg("comms list")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
	case http.MethodPost:
		b, ok := readCampaignBody(r)
		if !ok || !validCampaignText(b.Subject, b.BodyMarkdown) {
			writeErr(w, http.StatusBadRequest, "subject_body_invalid")
			return
		}
		seg, err := comms.ParseSegment(b.Segment)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "segment_invalid")
			return
		}
		c, err := h.store.CreateCampaign(r.Context(), adminEmail, b.Subject, b.BodyMarkdown, seg)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		h.store.cache.PublishEvent(r.Context(), "comms.campaign_created", map[string]any{"campaign_id": c.ID, "by": adminEmail})
		writeJSON(w, http.StatusCreated, c)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// GET ?id= / PUT {id,...} /api/admin/comms/campaign
func (h *Handler) handleCommsCampaign(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		id, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
		c, err := h.store.GetCampaign(r.Context(), id)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c)
	case http.MethodPut:
		b, ok := readCampaignBody(r)
		if !ok || b.ID == 0 || !validCampaignText(b.Subject, b.BodyMarkdown) {
			writeErr(w, http.StatusBadRequest, "subject_body_invalid")
			return
		}
		seg, err := comms.ParseSegment(b.Segment)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "segment_invalid")
			return
		}
		c, err := h.store.UpdateCampaignDraft(r.Context(), b.ID, b.Subject, b.BodyMarkdown, seg)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// POST /api/admin/comms/campaign/preview — {id} o {subject, body_markdown, segment}
func (h *Handler) handleCommsPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	subject, body, segRaw := b.Subject, b.BodyMarkdown, b.Segment
	if b.ID != 0 {
		c, err := h.store.GetCampaign(r.Context(), b.ID)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		subject, body, segRaw = c.Subject, c.BodyMarkdown, c.Segment
	}
	seg, err := comms.ParseSegment(segRaw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "segment_invalid")
		return
	}
	prev, err := h.store.PreviewAudience(r.Context(), seg)
	if err != nil {
		h.log.Error().Err(err).Msg("comms preview")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	rendered, err := comms.Render(comms.RenderInput{Subject: subject, BodyMarkdown: body, FirstName: "Nombre",
		UnsubscribeURL: comms.UnsubscribeURL(h.comms.sender.cfg.UnsubscribeBase, "preview")})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "render_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audience": prev, "html": rendered.HTML, "text": rendered.Text})
}

// POST /api/admin/comms/campaign/test — {id}: envía al admin autenticado (máx maxTestSends)
func (h *Handler) handleCommsTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.GetCampaign(r.Context(), b.ID)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	if err := h.store.IncrementTestSends(r.Context(), c.ID, h.comms.maxTestSends); err != nil {
		writeCommsErr(w, err)
		return
	}
	if err := h.comms.sender.SendTest(r.Context(), c, adminEmail); err != nil {
		h.log.Error().Err(err).Int64("campaign", c.ID).Msg("comms test send")
		writeErr(w, http.StatusBadGateway, "email_send_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": adminEmail})
}

// POST /api/admin/comms/campaign/submit — {id, reason}
func (h *Handler) handleCommsSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.SubmitCampaign(r.Context(), b.ID, adminEmail, b.Reason)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.store.cache.PublishEvent(r.Context(), "comms.campaign_submitted", map[string]any{"campaign_id": c.ID, "by": adminEmail, "audience": c.AudienceCount})
	writeJSON(w, http.StatusOK, c)
}

// POST /api/admin/comms/campaign/decide — {id, decision, reason} (super_admin)
func (h *Handler) handleCommsDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	superEmail, ok := h.requireSuperAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.DecideCampaign(r.Context(), b.ID, superEmail, b.Decision, strings.TrimSpace(b.Reason), h.comms.maxAudience, h.comms.maxPerDay)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.store.cache.PublishEvent(r.Context(), "comms.campaign_decided", map[string]any{"campaign_id": c.ID, "by": superEmail, "decision": b.Decision})
	h.log.Info().Int64("campaign", c.ID).Str("by", superEmail).Str("decision", b.Decision).Msg("comms campaign decided")
	writeJSON(w, http.StatusOK, c)
}

// POST /api/admin/comms/campaign/control — {id, action: pause|resume|cancel} (super_admin)
func (h *Handler) handleCommsControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	superEmail, ok := h.requireSuperAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	var err error
	switch b.Action {
	case "pause":
		err = h.store.SetCampaignStatus(r.Context(), b.ID, []string{"approved", "sending"}, "paused", "manual: "+superEmail)
	case "resume":
		err = h.store.SetCampaignStatus(r.Context(), b.ID, []string{"paused"}, "approved", "")
	case "cancel":
		if err = h.store.SetCampaignStatus(r.Context(), b.ID, []string{"pending_approval", "approved", "sending", "paused"}, "cancelled", ""); err == nil {
			_, err = h.store.db.Exec(r.Context(), `UPDATE comms.campaign_recipient SET status='skipped', skip_reason='cancelled'
				WHERE campaign_id=$1 AND status='queued'`, b.ID)
		}
	default:
		writeErr(w, http.StatusBadRequest, "action_invalid")
		return
	}
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	c, err := h.store.GetCampaign(r.Context(), b.ID)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.log.Info().Int64("campaign", c.ID).Str("by", superEmail).Str("action", b.Action).Msg("comms campaign control")
	writeJSON(w, http.StatusOK, c)
}

// GET /api/admin/comms/campaign/recipients?id=&status=&limit=&offset=
func (h *Handler) handleCommsRecipients(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	q := r.URL.Query()
	id, _ := strconv.ParseInt(q.Get("id"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	items, total, err := h.store.ListCampaignRecipients(r.Context(), id, q.Get("status"), limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// POST /api/comms/unsubscribe — {token}; solo service token (lo llama el BFF público de growth-hub)
func (h *Handler) handleCommsUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	if len(h.comms.unsubSecret) == 0 {
		writeErr(w, http.StatusServiceUnavailable, "comms_disabled")
		return
	}
	b, ok := readCampaignBody(r)
	if !ok || b.Token == "" {
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	pid, err := comms.VerifyUnsubscribe(h.comms.unsubSecret, b.Token, time.Now())
	switch {
	case errors.Is(err, comms.ErrUnsubscribeExpired):
		writeErr(w, http.StatusGone, "expired_token")
		return
	case err != nil:
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	var email string
	if err := h.store.db.QueryRow(r.Context(), `SELECT email::text FROM mlm.person WHERE id=$1`, pid).Scan(&email); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	if err := h.store.AddUnsubscribe(r.Context(), email, &pid, "link"); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.log.Info().Int64("person", pid).Msg("comms unsubscribe")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
```

Nota: `http.MaxBytesReader(nil, ...)` acepta `nil` ResponseWriter en Go ≥1.19? No: pasar `w`. Cambiar la firma a `readCampaignBody(w http.ResponseWriter, r *http.Request)` y usar `http.MaxBytesReader(w, r.Body, 64<<10)`; actualizar las llamadas.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run 'TestCommsHTTP_' -v && go vet ./internal/payments/`
Expected: PASS (2 tests), vet limpio.

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/comms_http.go vp-engine/internal/payments/http.go vp-engine/internal/payments/comms_http_integration_test.go
git commit -m "feat(comms): handlers admin de campañas y endpoint de baja"
```

---

### Task 12: Config, arranque en `main.go`, env de ejemplo e infraestructura AWS

**Files:**
- Modify: `vp-engine/internal/payments/config.go` (struct `Config` y `LoadConfig`)
- Modify: `vp-engine/cmd/vp-payments/main.go` (después del bloque `cfg.CartReminderEnabled`, ~línea 280)
- Modify: `vp-engine/deploy/vp-payments.env.example`
- Create: `_meta/devops/comms/README.md` (comandos AWS de la cola SQS, suscripción SNS, policy IAM, parámetros SSM)
- Create: `_meta/devops/iam/vp-comms-sqs.json`
- Test: `vp-engine/internal/payments/config_comms_test.go`

**Interfaces:**
- Produces en `Config`:
  ```go
  CommsEnabled            bool          // COMMS_ENABLED (default false)
  CommsSendRatePerSec     int           // COMMS_SEND_RATE_PER_SEC (10)
  CommsBatchSize          int           // COMMS_BATCH_SIZE (100)
  CommsSESConfigSet       string        // COMMS_SES_CONFIG_SET ("entregas")
  CommsUnsubscribeSecret  string        // COMMS_UNSUBSCRIBE_SECRET (requerido si enabled)
  CommsUnsubscribeBaseURL string        // COMMS_UNSUBSCRIBE_BASE_URL
  CommsReplyTo            string        // COMMS_REPLY_TO ("soporte@mindblisspower.com")
  CommsSQSQueueURL        string        // COMMS_SQS_QUEUE_URL ("" ⇒ sin consumer)
  CommsMaxAudience        int           // COMMS_MAX_AUDIENCE (150000)
  CommsMaxPerDay          int           // COMMS_MAX_CAMPAIGNS_PER_DAY (3)
  CommsMaxTestSends       int           // COMMS_MAX_TEST_SENDS (5)
  ```

- [ ] **Step 1: Test que falla**

```go
package payments

import "testing"

func TestLoadConfigCommsDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec_x")
	t.Setenv("PAYMENTS_SERVICE_TOKEN", "tok")
	t.Setenv("COMMS_ENABLED", "true")
	t.Setenv("COMMS_UNSUBSCRIBE_SECRET", "abc")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !cfg.CommsEnabled || cfg.CommsSendRatePerSec != 10 || cfg.CommsBatchSize != 100 || cfg.CommsSESConfigSet != "entregas" ||
		cfg.CommsMaxAudience != 150000 || cfg.CommsMaxPerDay != 3 || cfg.CommsMaxTestSends != 5 ||
		cfg.CommsReplyTo != "soporte@mindblisspower.com" || cfg.CommsUnsubscribeBaseURL != "https://app.mindblisspower.com/baja" {
		t.Fatalf("comms defaults wrong: %+v", cfg)
	}
	t.Setenv("COMMS_UNSUBSCRIBE_SECRET", "")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("COMMS_ENABLED sin COMMS_UNSUBSCRIBE_SECRET debe fallar")
	}
}
```

Si `LoadConfig` exige otras variables (ver las validaciones existentes en `config.go:150-200`), añadirlas al `t.Setenv` del test.

- [ ] **Step 2: Correr y ver que falla**

Run: `go test ./internal/payments/ -count=1 -run TestLoadConfigCommsDefaults`
Expected: FAIL `cfg.CommsEnabled undefined`

- [ ] **Step 3: Implementación**

En `Config` (tras el bloque de carritos):
```go
	// ── Comunicados masivos (comms) ────────────────────────────────────────────
	CommsEnabled            bool
	CommsSendRatePerSec     int
	CommsBatchSize          int
	CommsSESConfigSet       string
	CommsUnsubscribeSecret  string
	CommsUnsubscribeBaseURL string
	CommsReplyTo            string
	CommsSQSQueueURL        string
	CommsMaxAudience        int
	CommsMaxPerDay          int
	CommsMaxTestSends       int
```
En `LoadConfig`, dentro del literal `Config{...}`:
```go
		CommsEnabled:            envBool("COMMS_ENABLED", false),
		CommsSendRatePerSec:     envInt("COMMS_SEND_RATE_PER_SEC", 10),
		CommsBatchSize:          envInt("COMMS_BATCH_SIZE", 100),
		CommsSESConfigSet:       firstEnv("COMMS_SES_CONFIG_SET", "entregas"),
		CommsUnsubscribeSecret:  os.Getenv("COMMS_UNSUBSCRIBE_SECRET"),
		CommsUnsubscribeBaseURL: firstEnvDefault("COMMS_UNSUBSCRIBE_BASE_URL", "https://app.mindblisspower.com/baja"),
		CommsReplyTo:            firstEnvDefault("COMMS_REPLY_TO", "soporte@mindblisspower.com"),
		CommsSQSQueueURL:        os.Getenv("COMMS_SQS_QUEUE_URL"),
		CommsMaxAudience:        envInt("COMMS_MAX_AUDIENCE", 150000),
		CommsMaxPerDay:          envInt("COMMS_MAX_CAMPAIGNS_PER_DAY", 3),
		CommsMaxTestSends:       envInt("COMMS_MAX_TEST_SENDS", 5),
```
Ojo: `firstEnv(keys...)` devuelve el primer env no vacío; no acepta default. Añadir helper:
```go
func firstEnvDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
```
y para `CommsSESConfigSet` usar `firstEnvDefault("COMMS_SES_CONFIG_SET", "entregas")`.
Validación (junto a las demás de `LoadConfig`):
```go
	if cfg.CommsEnabled && strings.TrimSpace(cfg.CommsUnsubscribeSecret) == "" {
		return Config{}, fmt.Errorf("COMMS_ENABLED=true requiere COMMS_UNSUBSCRIBE_SECRET")
	}
```

En `main.go`, tras el bloque de `cfg.KYCOCRAPIKey` y antes de `errCh`:
```go
	// Comunicados masivos: sender (solo donde COMMS_ENABLED=true, i.e. APP) y
	// consumer de eventos SES por SQS. Non-fatal.
	if cfg.CommsEnabled {
		sender := payments.NewCommsSender(store, store, payments.CommsSenderConfig{
			RatePerSec: cfg.CommsSendRatePerSec, BatchSize: cfg.CommsBatchSize, SESConfigSet: cfg.CommsSESConfigSet,
			UnsubscribeSecret: []byte(cfg.CommsUnsubscribeSecret), UnsubscribeBase: cfg.CommsUnsubscribeBaseURL,
			ReplyTo: cfg.CommsReplyTo,
		}, logger.With().Str("component", "comms-sender").Logger())
		handler.SetComms(sender, cfg.CommsMaxAudience, cfg.CommsMaxPerDay, cfg.CommsMaxTestSends, []byte(cfg.CommsUnsubscribeSecret))
		go sender.Loop(rootCtx)
		if cfg.CommsSQSQueueURL != "" {
			if q, err := payments.NewSQSQueueClient(rootCtx, cfg.CommsSQSQueueURL); err != nil {
				logger.Error().Err(err).Msg("comms: SQS client init failed; sin seguimiento de entregas")
			} else {
				go payments.NewCommsEventConsumer(store, q, logger.With().Str("component", "comms-events").Logger()).Loop(rootCtx)
			}
		}
	} else if cfg.CommsUnsubscribeSecret != "" {
		// Sin sender pero con secreto: el endpoint de baja sigue funcionando (WORKER/staging)
		handler.SetComms(nil, 0, 0, 0, []byte(cfg.CommsUnsubscribeSecret))
	}
```
`SetComms(nil, ...)` deja `h.comms.sender == nil` ⇒ los handlers admin responden `comms_disabled` y solo `/api/comms/unsubscribe` funciona.

`vp-engine/deploy/vp-payments.env.example`, añadir:
```
# --- Comunicados masivos por correo ---
# Sender activo SOLO en el box APP (un único proceso envía).
COMMS_ENABLED=false
COMMS_SEND_RATE_PER_SEC=10
COMMS_BATCH_SIZE=100
COMMS_SES_CONFIG_SET=entregas
# Secreto propio (32+ bytes aleatorios) para firmar links de baja. NO reutilizar PAYMENTS_SERVICE_TOKEN.
COMMS_UNSUBSCRIBE_SECRET=__random_32_bytes__
COMMS_UNSUBSCRIBE_BASE_URL=https://app.mindblisspower.com/baja
COMMS_REPLY_TO=soporte@mindblisspower.com
# Cola SQS suscrita al topic SNS ses-entregas-eventos (vacío = sin seguimiento)
COMMS_SQS_QUEUE_URL=
COMMS_MAX_AUDIENCE=150000
COMMS_MAX_CAMPAIGNS_PER_DAY=3
COMMS_MAX_TEST_SENDS=5
```

`_meta/devops/iam/vp-comms-sqs.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ConsumeCommsSesEvents",
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      "Resource": "arn:aws:sqs:us-east-1:522814703714:comms-ses-events"
    }
  ]
}
```

`_meta/devops/comms/README.md` (comandos a ejecutar UNA vez por el operador, no en CI):
```bash
export MSYS_NO_PATHCONV=1 PYTHONUTF8=1
ACCOUNT=522814703714; REGION=us-east-1
TOPIC=arn:aws:sns:$REGION:$ACCOUNT:ses-entregas-eventos

# 1) DLQ + cola principal
DLQ_URL=$(aws sqs create-queue --queue-name comms-ses-events-dlq --region $REGION --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)
Q_URL=$(aws sqs create-queue --queue-name comms-ses-events --region $REGION --attributes "{\"MessageRetentionPeriod\":\"345600\",\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" --query QueueUrl --output text)
Q_ARN=$(aws sqs get-queue-attributes --queue-url $Q_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)

# 2) Policy de la cola: solo el topic SNS puede publicar
aws sqs set-queue-attributes --queue-url $Q_URL --attributes "{\"Policy\":\"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"sns.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"$Q_ARN\\\",\\\"Condition\\\":{\\\"ArnEquals\\\":{\\\"aws:SourceArn\\\":\\\"$TOPIC\\\"}}}]}\"}"

# 3) Suscripción SNS → SQS con raw delivery (el body es el JSON del evento SES)
aws sns subscribe --topic-arn $TOPIC --protocol sqs --notification-endpoint $Q_ARN --attributes RawMessageDelivery=true --region $REGION

# 4) IAM: el rol de instancia consume la cola
aws iam put-role-policy --role-name vp-ec2-ssm --policy-name vp-comms-sqs --policy-document file://_meta/devops/iam/vp-comms-sqs.json

# 5) Parámetros SSM que renderizan /run/vicionpower/vp-payments.env (APP)
P=/vicionpower/prod/vp-payments
aws ssm put-parameter --name $P/COMMS_ENABLED --value true --type String --overwrite
aws ssm put-parameter --name $P/COMMS_UNSUBSCRIBE_SECRET --value "$(openssl rand -base64 48)" --type SecureString --overwrite
aws ssm put-parameter --name $P/COMMS_SQS_QUEUE_URL --value "$Q_URL" --type String --overwrite
aws ssm put-parameter --name $P/COMMS_SES_CONFIG_SET --value entregas --type String --overwrite
# En WORKER/staging: COMMS_ENABLED=false (no crear el parámetro o ponerlo en false).
```
Verificar antes de ejecutar que el script de deploy renderiza TODOS los parámetros bajo `$P/*` (hoy sí: `COGNITO_ISSUER`, `KYC_S3_BUCKET`, etc. llegan al contenedor). Si el secreto SecureString necesita `kms:Decrypt`, el rol ya lo tiene vía `vp-ssm-read`.

- [ ] **Step 4: Correr y ver que pasa**

Run: `go test ./internal/payments/ -count=1 -run TestLoadConfigCommsDefaults && go build ./... && go vet ./cmd/vp-payments/`
Expected: PASS y build OK.

- [ ] **Step 5: Commit**

```bash
git add vp-engine/internal/payments/config.go vp-engine/internal/payments/config_comms_test.go vp-engine/cmd/vp-payments/main.go vp-engine/deploy/vp-payments.env.example _meta/devops/comms/README.md _meta/devops/iam/vp-comms-sqs.json
git commit -m "feat(comms): configuración, arranque de sender/consumer y runbook de infra SQS/SNS/IAM"
```

---

### Task 13: Panel admin — BFF, página y sección Comunicados

**Files:**
- Create: `mindblisspower-admin/src/app/api/admin/comms/campaigns/route.js` (GET, POST)
- Create: `mindblisspower-admin/src/app/api/admin/comms/campaign/route.js` (GET, PUT)
- Create: `mindblisspower-admin/src/app/api/admin/comms/campaign/[action]/route.js` (POST → preview|test|submit|decide|control; GET → recipients)
- Create: `mindblisspower-admin/src/components/sections/ComunicadosSection.jsx`
- Create: `mindblisspower-admin/src/app/dashboard/comunicados/page.jsx`
- Modify: `mindblisspower-admin/src/components/AdminShell.jsx:20` (entrada de menú tras "Salud de acceso")
- Test: `mindblisspower-admin/src/app/api/admin/comms/comms-routes.test.mjs`

**Interfaces:**
- Consumes: `callPayments`, `sessionEmail` (`src/lib/admin-bff.js:33,151`); rutas Go de Task 11.
- Produces: `/dashboard/comunicados`.

- [ ] **Step 1: Test del BFF que falla** (node test runner, mismo estilo que los tests existentes en `src/**/*.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";

const ALLOWED = new Set(["preview", "test", "submit", "decide", "control", "recipients"]);

test("comms action allowlist", async () => {
  const { isAllowedAction } = await import("./campaign/[action]/actions.mjs");
  for (const a of ALLOWED) assert.equal(isAllowedAction(a), true);
  assert.equal(isAllowedAction("delete"), false);
  assert.equal(isAllowedAction("../email"), false);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd D:\vicionpower\mindblisspower-admin && node --test "src/app/api/admin/comms/**/*.test.mjs"`
Expected: FAIL (módulo `actions.mjs` no existe)

- [ ] **Step 3: Implementación**

`src/app/api/admin/comms/campaign/[action]/actions.mjs`:
```js
const ALLOWED = new Set(["preview", "test", "submit", "decide", "control", "recipients"]);
export function isAllowedAction(a) {
  return typeof a === "string" && ALLOWED.has(a);
}
```

`src/app/api/admin/comms/campaigns/route.js`:
```js
import { NextResponse } from "next/server";
import { callPayments, sessionEmail } from "@/lib/admin-bff";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const p = new URL(request.url).searchParams;
  const qs = new URLSearchParams({ email, status: p.get("status") || "", limit: p.get("limit") || "25", offset: p.get("offset") || "0" });
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaigns?${qs}`);
  return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function POST(request) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaigns?email=${encodeURIComponent(email)}`, { method: "POST", body });
  return NextResponse.json(data, { status: ok ? 201 : status });
}
```

`src/app/api/admin/comms/campaign/route.js`:
```js
import { NextResponse } from "next/server";
import { callPayments, sessionEmail } from "@/lib/admin-bff";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") || "";
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaign?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`);
  return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function PUT(request) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaign?email=${encodeURIComponent(email)}`, { method: "PUT", body });
  return NextResponse.json(data, { status: ok ? 200 : status });
}
```

`src/app/api/admin/comms/campaign/[action]/route.js`:
```js
import { NextResponse } from "next/server";
import { callPayments, sessionEmail } from "@/lib/admin-bff";
import { isAllowedAction } from "./actions.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { action } = await params;
  if (!isAllowedAction(action) || action === "recipients") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaign/${action}?email=${encodeURIComponent(email)}`, { method: "POST", body });
  return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function GET(request, { params }) {
  const { action } = await params;
  if (action !== "recipients") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const p = new URL(request.url).searchParams;
  const qs = new URLSearchParams({ email, id: p.get("id") || "", status: p.get("status") || "", limit: p.get("limit") || "50", offset: p.get("offset") || "0" });
  const { ok, status, data } = await callPayments(`/api/admin/comms/campaign/recipients?${qs}`);
  return NextResponse.json(data, { status: ok ? 200 : status });
}
```
Comprobar si `callPayments` ya verifica `PUT`/mutaciones bajo impersonación (`impersonationDecision` en `admin-bff.js:214`); las rutas nuevas heredan esa protección al pasar por `callPayments`.

`src/app/dashboard/comunicados/page.jsx`:
```jsx
import ComunicadosSection from "@/components/sections/ComunicadosSection";

export default function ComunicadosPage() {
  return (
    <section className="executive-page"><div className="executive-container">
      <div className="executive-page-header">
        <div>
          <p className="executive-eyebrow">Operación</p>
          <h1 className="executive-title">Comunicados</h1>
          <p className="executive-subtitle">Mensajes por correo a segmentos de miembros: redacta, prueba, solicita aprobación y sigue las entregas.</p>
        </div>
      </div>
      <ComunicadosSection />
    </div></section>
  );
}
```

`AdminShell.jsx`, tras la línea de "Salud de acceso":
```jsx
      { href: "/dashboard/comunicados", label: "Comunicados", icon: Megaphone },
```
e importar `Megaphone` de `lucide-react` junto a los demás iconos.

`src/components/sections/ComunicadosSection.jsx` — componente cliente con tres vistas (lista, editor, detalle). Estructura mínima obligatoria:

```jsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone, Send, ShieldCheck, Pause, Play, X, Eye } from "lucide-react";

const STATUS_META = {
  draft: "Borrador", pending_approval: "Pendiente de aprobación", approved: "Aprobada",
  sending: "Enviando", paused: "Pausada", done: "Finalizada", cancelled: "Cancelada", rejected: "Rechazada",
};
const ERR = {
  campaign_invalid_state: "La campaña no está en un estado válido para esta acción.",
  same_approver: "Quien redacta no puede aprobar su propio comunicado.",
  audience_too_large: "La audiencia supera el máximo permitido.",
  daily_campaign_limit: "Se alcanzó el límite diario de campañas.",
  test_send_limit: "Máximo de envíos de prueba alcanzado.",
  not_super_admin: "Solo un super admin puede aprobar o controlar campañas.",
  reason_too_short: "El motivo debe tener al menos 10 caracteres.",
  segment_invalid: "El segmento no es válido.",
  comms_disabled: "Los comunicados no están habilitados en este servidor.",
};
const EMPTY = { subject: "", body_markdown: "", segment: { status: ["active"], rank_ids: [], phone_country_ids: [], membership: "any", emails: [] } };

async function api(path, opts) {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts?.headers || {}) }, body: opts?.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(ERR[data?.error] || data?.error || `HTTP ${r.status}`);
  return data;
}

export default function ComunicadosSection() {
  const [view, setView] = useState("list"); // list | edit | detail
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [preview, setPreview] = useState(null);
  const [recipients, setRecipients] = useState({ items: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try { setItems((await api("/api/admin/comms/campaigns?limit=50")).items || []); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // polling de progreso mientras la campaña abierta está enviando
  useEffect(() => {
    if (view !== "detail" || !current || !["sending", "approved"].includes(current.status)) return;
    const t = setInterval(async () => {
      try {
        setCurrent(await api(`/api/admin/comms/campaign?id=${current.id}`));
        setRecipients(await api(`/api/admin/comms/campaign/recipients?id=${current.id}&limit=50`));
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [view, current]);

  const run = async (fn, okMsg) => {
    setBusy(true); setMsg("");
    try { const out = await fn(); if (okMsg) setMsg(okMsg); return out; }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  const openDetail = async (c) => {
    setCurrent(c); setView("detail");
    await run(async () => setRecipients(await api(`/api/admin/comms/campaign/recipients?id=${c.id}&limit=50`)));
  };
  const save = () => run(async () => {
    const c = current?.id
      ? await api("/api/admin/comms/campaign", { method: "PUT", body: { id: current.id, ...form } })
      : await api("/api/admin/comms/campaigns", { method: "POST", body: form });
    setCurrent(c); await load(); return c;
  }, "Borrador guardado.");
  const doPreview = () => run(async () => setPreview(await api("/api/admin/comms/campaign/preview", { method: "POST", body: current?.id ? { id: current.id } : form })));
  const sendTest = () => run(() => api("/api/admin/comms/campaign/test", { method: "POST", body: { id: current.id } }), "Correo de prueba enviado a tu buzón.");
  const submit = () => {
    const reason = window.prompt("Motivo del comunicado (mínimo 10 caracteres):");
    if (!reason) return;
    return run(async () => { setCurrent(await api("/api/admin/comms/campaign/submit", { method: "POST", body: { id: current.id, reason } })); await load(); setView("detail"); }, "Enviado a aprobación.");
  };
  const decide = (decision) => {
    const reason = window.prompt(decision === "approve" ? "Motivo de aprobación:" : "Motivo de rechazo:");
    if (reason === null) return;
    return run(async () => { setCurrent(await api("/api/admin/comms/campaign/decide", { method: "POST", body: { id: current.id, decision, reason } })); await load(); });
  };
  const control = (action) => run(async () => { setCurrent(await api("/api/admin/comms/campaign/control", { method: "POST", body: { id: current.id, action } })); await load(); });

  if (view === "edit") {
    return (
      <div className="executive-card">
        <label className="executive-label">Asunto</label>
        <input className="executive-input" maxLength={150} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        <label className="executive-label">Cuerpo (Markdown: negrita, listas, enlaces https)</label>
        <textarea className="executive-input" rows={12} value={form.body_markdown} onChange={(e) => setForm({ ...form, body_markdown: e.target.value })} />
        <fieldset className="executive-fieldset">
          <legend>Segmento</legend>
          <label><input type="checkbox" checked={form.segment.status.includes("active")} onChange={(e) => setForm({ ...form, segment: { ...form.segment, status: e.target.checked ? ["active"] : ["active", "pending"] } })} /> Solo miembros activos</label>
          <label>Membresía
            <select value={form.segment.membership} onChange={(e) => setForm({ ...form, segment: { ...form.segment, membership: e.target.value } })}>
              <option value="any">Cualquiera</option><option value="active">Vigente</option><option value="expired">Vencida</option>
            </select>
          </label>
          <label>Rangos (ids separados por coma)
            <input className="executive-input" value={form.segment.rank_ids.join(",")} onChange={(e) => setForm({ ...form, segment: { ...form.segment, rank_ids: e.target.value.split(",").map((x) => parseInt(x, 10)).filter(Number.isInteger) } })} />
          </label>
          <label>Códigos de país del teléfono (ids separados por coma)
            <input className="executive-input" value={form.segment.phone_country_ids.join(",")} onChange={(e) => setForm({ ...form, segment: { ...form.segment, phone_country_ids: e.target.value.split(",").map((x) => parseInt(x, 10)).filter(Number.isInteger) } })} />
          </label>
          <label>O lista de emails (uno por línea; si se usa, ignora los filtros)
            <textarea className="executive-input" rows={4} value={form.segment.emails.join("\n")} onChange={(e) => setForm({ ...form, segment: { ...form.segment, emails: e.target.value.split(/\s+/).filter(Boolean) } })} />
          </label>
        </fieldset>
        <div className="executive-actions">
          <button className="executive-btn" disabled={busy} onClick={save}>Guardar borrador</button>
          <button className="executive-btn" disabled={busy} onClick={doPreview}><Eye size={16} /> Calcular audiencia y previsualizar</button>
          <button className="executive-btn" disabled={busy || !current?.id} onClick={sendTest}><Send size={16} /> Enviar prueba a mi correo</button>
          <button className="executive-btn executive-btn-primary" disabled={busy || !current?.id} onClick={submit}><ShieldCheck size={16} /> Solicitar aprobación</button>
          <button className="executive-btn" onClick={() => { setView("list"); setPreview(null); }}><X size={16} /> Volver</button>
        </div>
        {msg && <p className="executive-note">{msg}</p>}
        {preview && (
          <div className="executive-card">
            <p><strong>Audiencia elegible:</strong> {preview.audience.eligible} · excluidos: bajas {preview.audience.excluded.unsubscribed}, rebotes {preview.audience.excluded.suppressed}, baneados/admins {preview.audience.excluded.blacklisted}, inválidos {preview.audience.excluded.invalid}</p>
            <iframe title="preview" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 520, border: "1px solid var(--vp-border)", borderRadius: 8, background: "#fff" }} />
          </div>
        )}
      </div>
    );
  }

  if (view === "detail" && current) {
    const c = current;
    return (
      <div className="executive-card">
        <h2 className="executive-title">{c.subject}</h2>
        <p className="executive-subtitle">{STATUS_META[c.status] || c.status} · creada por {c.created_by}{c.approved_by ? ` · decidida por ${c.approved_by}` : ""}{c.pause_reason ? ` · pausa: ${c.pause_reason}` : ""}</p>
        <div className="executive-kpis">
          {[["Audiencia", c.audience_count ?? "—"], ["Enviados", c.sent_count], ["Entregados", c.delivered_count], ["Rebotes", c.bounced_count], ["Quejas", c.complained_count], ["Fallidos", c.failed_count]].map(([k, v]) => (
            <div key={k} className="executive-kpi"><span>{k}</span><strong>{v}</strong></div>
          ))}
        </div>
        <div className="executive-actions">
          {c.status === "draft" && <button className="executive-btn" onClick={() => { setForm({ subject: c.subject, body_markdown: c.body_markdown, segment: c.segment }); setView("edit"); }}>Editar</button>}
          {c.status === "pending_approval" && <>
            <button className="executive-btn executive-btn-primary" disabled={busy} onClick={() => decide("approve")}><ShieldCheck size={16} /> Aprobar y enviar</button>
            <button className="executive-btn" disabled={busy} onClick={() => decide("reject")}>Rechazar</button>
          </>}
          {["approved", "sending"].includes(c.status) && <button className="executive-btn" disabled={busy} onClick={() => control("pause")}><Pause size={16} /> Pausar</button>}
          {c.status === "paused" && <button className="executive-btn" disabled={busy} onClick={() => control("resume")}><Play size={16} /> Reanudar</button>}
          {["pending_approval", "approved", "sending", "paused"].includes(c.status) && <button className="executive-btn" disabled={busy} onClick={() => { if (window.confirm("¿Cancelar la campaña? Los pendientes no se enviarán.")) control("cancel"); }}>Cancelar</button>}
          <button className="executive-btn" onClick={() => setView("list")}><X size={16} /> Volver</button>
        </div>
        {msg && <p className="executive-note">{msg}</p>}
        <table className="executive-table">
          <thead><tr><th>Email</th><th>Estado</th><th>Intentos</th><th>Error</th></tr></thead>
          <tbody>{recipients.items.map((r) => (
            <tr key={r.person_id}><td>{r.email}</td><td>{r.status}</td><td>{r.attempts}</td><td>{r.last_error || r.skip_reason || ""}</td></tr>
          ))}</tbody>
        </table>
        <p className="executive-note">Mostrando {recipients.items.length} de {recipients.total}.</p>
      </div>
    );
  }

  return (
    <div className="executive-card">
      <div className="executive-actions">
        <button className="executive-btn executive-btn-primary" onClick={() => { setCurrent(null); setForm(EMPTY); setPreview(null); setView("edit"); }}><Megaphone size={16} /> Nuevo comunicado</button>
        {busy && <Loader2 className="spin" size={16} />}
      </div>
      {msg && <p className="executive-note">{msg}</p>}
      <table className="executive-table">
        <thead><tr><th>#</th><th>Asunto</th><th>Estado</th><th>Audiencia</th><th>Enviados</th><th>Entregados</th><th>Creada</th></tr></thead>
        <tbody>{items.map((c) => (
          <tr key={c.id} onClick={() => openDetail(c)} style={{ cursor: "pointer" }}>
            <td>{c.id}</td><td>{c.subject}</td><td>{STATUS_META[c.status] || c.status}</td><td>{c.audience_count ?? "—"}</td><td>{c.sent_count}</td><td>{c.delivered_count}</td><td>{new Date(c.created_at).toLocaleString("es-CO")}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
```
Usar las clases CSS que ya existan en el panel (`executive-*`); si alguna no existe, reutilizar las de `TicketsSection.jsx` en lugar de crear estilos nuevos.

- [ ] **Step 4: Correr tests y build**

Run: `node --test "src/**/*.test.mjs" && node node_modules/next/dist/bin/next build`
Expected: tests PASS, build OK. Probar en local (`npm run dev`, puerto del panel) el flujo completo contra un vp-payments local con `COMMS_ENABLED=true` y `fakeEmailSender` no aplica: usar SES real con tu propio email en `emails` del segmento.

- [ ] **Step 5: Commit**

```bash
cd D:\vicionpower\mindblisspower-admin
git add src/app/api/admin/comms src/components/sections/ComunicadosSection.jsx src/app/dashboard/comunicados src/components/AdminShell.jsx
git commit -m "feat(comunicados): página, editor, aprobación y seguimiento de campañas de correo"
```

---

### Task 14: growth-hub — página pública `/baja` y BFF de baja

**Files:**
- Create: `mindblisspowerfront/src/app/api/comms/unsubscribe/route.js`
- Create: `mindblisspowerfront/src/app/baja/page.jsx`
- Create: `mindblisspowerfront/src/app/baja/UnsubscribeForm.jsx`
- Test: `mindblisspowerfront/src/app/api/comms/unsubscribe/unsubscribe.test.mjs`

**Interfaces:**
- Consumes: `authRateLimit` (`src/lib/auth-rate-limit.js`), env `VP_PAYMENTS_URL` + `PAYMENTS_SERVICE_TOKEN` (mismo patrón que `access-help/route.js`), endpoint Go `/api/comms/unsubscribe` (Task 11).
- Produces: `GET /baja?t=<token>` muestra confirmación; el botón hace `POST /api/comms/unsubscribe {token}`. Un `POST` con `List-Unsubscribe=One-Click` (form-urlencoded) al mismo path `/baja?t=` también debe dar de baja: Gmail/Yahoo lo envían sin interacción.

- [ ] **Step 1: Test que falla**

```js
import test from "node:test";
import assert from "node:assert/strict";

test("token extraction accepts query and form body", async () => {
  const { extractToken } = await import("./token.mjs");
  assert.equal(extractToken({ t: "abc" }, null), "abc");
  assert.equal(extractToken({}, { token: "xyz" }), "xyz");
  assert.equal(extractToken({ t: "a b" }, null), "");           // espacios no válidos
  assert.equal(extractToken({ t: "x".repeat(600) }, null), ""); // demasiado largo
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd D:\vicionpower\mindblisspowerfront && node --test "src/app/api/comms/**/*.test.mjs"`
Expected: FAIL (módulo `token.mjs` no existe)

- [ ] **Step 3: Implementación**

`src/app/api/comms/unsubscribe/token.mjs`:
```js
const RE = /^[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{20,100}$/;
export function extractToken(query, body) {
  const raw = (query && query.t) || (body && body.token) || "";
  return RE.test(raw) ? raw : "";
}
```

`src/app/api/comms/unsubscribe/route.js`:
```js
import { NextResponse } from "next/server";
import { authRateLimit } from "@/lib/auth-rate-limit";
import { extractToken } from "./token.mjs";

export const runtime = "nodejs";

async function unsubscribe(request, token) {
  const limited = authRateLimit(request, { name: "unsubscribe", preset: "send", email: token.slice(0, 32) });
  if (limited) return limited;
  const base = process.env.VP_PAYMENTS_URL;
  const svc = process.env.PAYMENTS_SERVICE_TOKEN;
  if (!base || !svc) return NextResponse.json({ error: "No disponible en este momento." }, { status: 503 });
  const resp = await fetch(`${base}/api/comms/unsubscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-VP-Service-Token": svc },
    body: JSON.stringify({ token }),
    cache: "no-store",
  }).catch(() => null);
  if (!resp) return NextResponse.json({ error: "No disponible en este momento." }, { status: 503 });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 410) return NextResponse.json({ error: "El enlace expiró. Escríbenos a soporte@mindblisspower.com." }, { status: 410 });
  if (!resp.ok) return NextResponse.json({ error: "Enlace inválido." }, { status: 400 });
  return NextResponse.json({ ok: true, ...data });
}

// POST /api/comms/unsubscribe — JSON {token} (botón de la página) o
// form-urlencoded List-Unsubscribe=One-Click con ?t= (Gmail/Yahoo).
export async function POST(request) {
  const url = new URL(request.url);
  let body = null;
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) body = await request.json().catch(() => null);
  const token = extractToken({ t: url.searchParams.get("t") }, body);
  if (!token) return NextResponse.json({ error: "Enlace inválido." }, { status: 400 });
  return unsubscribe(request, token);
}
```

`src/app/baja/page.jsx`:
```jsx
import UnsubscribeForm from "./UnsubscribeForm";

export const metadata = { title: "Darse de baja · Mindbliss Power" };

export default async function BajaPage({ searchParams }) {
  const sp = (await searchParams) ?? {};
  const token = typeof sp.t === "string" ? sp.t : "";
  return (
    <main style={{ maxWidth: 520, margin: "48px auto", padding: "0 16px", color: "var(--vp-text)" }}>
      <h1 className="auth-display text-3xl">Comunicados por correo</h1>
      <p style={{ marginTop: 12 }}>Si confirmas, dejarás de recibir los comunicados generales de Mindbliss Power. Los correos de tu cuenta (códigos de acceso, comprobantes y soporte) seguirán llegando.</p>
      <UnsubscribeForm token={token} />
    </main>
  );
}
```

`src/app/baja/UnsubscribeForm.jsx`:
```jsx
"use client";
import { useState } from "react";

export default function UnsubscribeForm({ token }) {
  const [state, setState] = useState({ busy: false, done: false, error: token ? "" : "Enlace inválido." });
  const confirm = async () => {
    setState({ busy: true, done: false, error: "" });
    const r = await fetch("/api/comms/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const data = await r.json().catch(() => ({}));
    setState({ busy: false, done: r.ok, error: r.ok ? "" : data.error || "No se pudo procesar." });
  };
  if (state.done) return <p style={{ marginTop: 24 }}>Listo. No volverás a recibir comunicados generales.</p>;
  return (
    <div style={{ marginTop: 24 }}>
      <button type="button" disabled={state.busy || !token} onClick={confirm} className="auth-button">
        {state.busy ? "Procesando…" : "Confirmar baja"}
      </button>
      {state.error && <p style={{ color: "#f87171", marginTop: 12 }}>{state.error}</p>}
    </div>
  );
}
```
Además, para que el One-Click POST de Gmail (a la URL de `List-Unsubscribe`, es decir `/baja?t=`) funcione sin JS, crear `src/app/baja/route.js`? No: Next no permite `page.jsx` y `route.js` en el mismo segmento. Solución: en `comms_sender.go` la cabecera `List-Unsubscribe` debe apuntar a `<UnsubscribeBase>/../api/comms/unsubscribe?t=<token>` y el enlace visible del pie a `/baja?t=`. Implementarlo así: en Task 9, `HTMLEmail.UnsubscribeURL` (cabecera) = `strings.Replace(base, "/baja", "/api/comms/unsubscribe", 1) + "?t=" + tok`, mientras `RenderInput.UnsubscribeURL` (pie) sigue siendo `/baja?t=`. Añadir un test unitario en `comms_sender_integration_test.go` que compruebe que `f.sent[0].UnsubscribeURL` contiene `/api/comms/unsubscribe?t=`.

- [ ] **Step 4: Correr tests y build**

Run: `node --test "src/**/*.test.mjs" && node node_modules/next/dist/bin/next build`
Expected: PASS y build OK.

- [ ] **Step 5: Commit**

```bash
cd D:\vicionpower\mindblisspowerfront
git add src/app/api/comms src/app/baja
git commit -m "feat(baja): página pública y endpoint de baja de comunicados (incl. One-Click)"
```
Y en backend, el ajuste de la cabecera:
```bash
cd D:\vicionpower\backend
git add vp-engine/internal/payments/comms_sender.go vp-engine/internal/payments/comms_sender_integration_test.go
git commit -m "fix(comms): List-Unsubscribe apunta al endpoint One-Click; el pie a /baja"
```

---

### Task 15: Validación en staging, deploy y smoke en producción

**Files:**
- Modify: `_meta/devops/comms/README.md` (sección "Rollout")
- Modify: `C:\Users\alain\.claude\projects\D--vicionpower\memory\` (nota de proyecto al terminar; fuera del repo)

- [ ] **Step 1: Migración 67 en RDS** (como `postgres`, mismo procedimiento que la 66: SSM + `docker run postgres:17 psql` con el secreto `vicionpower/prod/rds-master`). Verificar: `SELECT count(*) FROM information_schema.tables WHERE table_schema='comms'` → 4, y `SELECT 'comms_campaign'::mlm.approval_operation_type`.

- [ ] **Step 2: Infra AWS** — ejecutar los pasos 1-5 del README (cola, policy, suscripción, IAM, SSM). Verificar la suscripción: `aws sns list-subscriptions-by-topic --topic-arn ... --query 'Subscriptions[?Protocol==`sqs`]'` y que `RawMessageDelivery=true`.

- [ ] **Step 3: CI** — push de backend a `main` (build.yml corre tests con Docker + publica imágenes); front del panel y growth-hub se despliegan por su CI al hacer push a `main`.

- [ ] **Step 4: Deploy backend** — `gh workflow run deploy -R Alain-Colombia-Arbitrage-Mev/mindblisspower-back -f tag=<sha> -f environment=prod`. Comprobar en APP: `docker logs compose-vp-payments-1 | grep -E 'comms (sender|event consumer) started'`. En WORKER el log NO debe mostrar `comms sender started` (`COMMS_ENABLED` ausente).

- [ ] **Step 5: Smoke en producción con audiencia controlada**
  1. Panel → Comunicados → Nuevo: asunto "Prueba de comunicados", cuerpo corto, segmento con `emails` = 3 buzones propios (Gmail, Outlook, Yahoo).
  2. "Calcular audiencia" → elegible 3. "Enviar prueba a mi correo" → llega con pie y enlace de baja.
  3. "Solicitar aprobación" (admin) → aprobar con super_admin distinto → en ≤10 s estado `done`, 3 enviados.
  4. Verificar en los 3 buzones: bandeja de entrada (no spam), cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post` (Gmail: "Mostrar original"), `Reply-To: soporte@mindblisspower.com`.
  5. Esperar 1-2 min: detalle muestra `delivered_count = 3` (eventos vía SQS). `aws logs filter-log-events --log-group-name /aws/lambda/mbp-ses-event-logger --filter-pattern Delivery` también los muestra.
  6. Pulsar "Darse de baja" desde uno de los buzones → página `/baja` confirma; nueva campaña de prueba con los mismos 3 emails → audiencia elegible 2, excluidos bajas 1.
  7. Responder al correo desde un buzón → la respuesta aparece como conversación en Chatwoot (`soporte@`).

- [ ] **Step 6: Documentar y cerrar** — añadir al README la sección "Rollout" con fecha, SHA desplegado, URL de la cola y resultados del smoke; guardar nota de memoria del proyecto.

- [ ] **Step 7: Commit**

```bash
cd D:\vicionpower\backend
git add _meta/devops/comms/README.md
git commit -m "docs(comms): rollout a producción y smoke"
git push origin main
```

---

## Self-review (hecho al escribir el plan)

- **Cobertura del spec:** §4 datos → Task 1; segmentos → Task 2/7; flujo y estados → Tasks 7-9, 11; contenido y cabeceras → Tasks 4, 6, 9, 14; seguimiento SQS → Task 10 + README de Task 12; API → Task 11; panel → Task 13; baja pública → Task 14; configuración → Task 12; errores y límites (AccessDenied → pausa, throttling → backoff, stale → failed, máx audiencia, 3/día, 5 % rebotes) → Tasks 5, 7-10; pruebas → cada task + Task 15.
- **Desviaciones respecto al spec:** (1) la lógica con DB/HTTP vive en `internal/payments/comms_*.go` en vez de todo en `internal/comms`, para reutilizar `requireAdmin`/`Store` sin exportar internals; (2) rutas planas con `?id=`/body en lugar de `/{id}` (convención del mux existente); (3) la cabecera `List-Unsubscribe` apunta a `/api/comms/unsubscribe?t=` (One-Click) y el enlace visible a `/baja?t=`; (4) el sender es at-most-once (filas `sending` atascadas se marcan `failed`, nunca se reenvían).
- **Consistencia de nombres:** `EmailSender`/`HTMLEmail` (Task 6) usados en Tasks 9, 11; `QueueClient`/`QueueMessage` (Task 10); `CommsSenderConfig.UnsubscribeBase` (Task 9) leído en Task 11 (`h.comms.sender.cfg.UnsubscribeBase`); `ErrTestSendLimit` definido en Task 7 y usado en Task 11; `approvedCampaign`, `fakeEmailSender`, `fakeAPIErr`, `newTestSender` definidos en Task 9 y reutilizados en Tasks 10-11 (mismo package de test); `seedAdmin` ya existe en `plan_integration_test.go`.
- **Pendiente de verificar en implementación:** nombres del enum `mlm.approval_status` (Task 8), existencia de `sestypes.MessageHeader` en la versión del SDK (Task 6), comportamiento de `applySchema` con el `ALTER TYPE` fuera de transacción (Task 1).
