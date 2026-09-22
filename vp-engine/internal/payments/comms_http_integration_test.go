package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
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
