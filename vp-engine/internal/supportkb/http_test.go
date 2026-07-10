package supportkb

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// fakeVerifier acepta tokens con forma "ok:<email>".
type fakeVerifier struct{}

func (fakeVerifier) VerifyEmail(_ context.Context, raw string) (string, error) {
	if e, ok := strings.CutPrefix(raw, "ok:"); ok {
		return strings.ToLower(e), nil
	}
	return "", errors.New("token inválido")
}

// newTestStack monta Handler con OpenRouter y Qdrant falsos. lastFilter
// captura el filtro que recibió Qdrant en la última búsqueda; score controla
// el score del hit devuelto (para probar el umbral de escalado del bot).
func newTestStack(t *testing.T, score float64, chatAnswer string, lastFilter *map[string]any) *Handler {
	t.Helper()

	embMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Input []string `json:"input"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		type item struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		}
		out := struct {
			Data []item `json:"data"`
		}{}
		for i := range req.Input {
			out.Data = append(out.Data, item{Index: i, Embedding: make([]float32, EmbedDims)})
		}
		json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(embMock.Close)

	chatMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": chatAnswer}}},
		})
	}))
	t.Cleanup(chatMock.Close)

	qdMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/points/search") {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		if lastFilter != nil {
			*lastFilter, _ = req["filter"].(map[string]any)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"result": []map[string]any{{
				"id": "11111111-1111-1111-1111-111111111111", "score": score,
				"payload": map[string]any{
					"doc_id": "d1", "titulo": "Política de retiros", "categoria": "retiros",
					"ord": float64(0), "texto": "Los retiros se pagan el día 1.",
				},
			}},
		})
	}))
	t.Cleanup(qdMock.Close)

	emb := NewEmbedder("k", embMock.URL)
	qd := NewQdrant(qdMock.URL, "", "kb")
	sr := NewSearcher(emb, qd)
	bot := NewBot(sr, "k", chatMock.URL, "test-model", 0.45)

	// pool nil: estos tests no tocan los endpoints de docs que usan Postgres.
	h := NewHandler(nil, sr, bot, "tok-secreto", []string{"devfidubit@gmail.com"}, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{}, false)
	return h
}

func doReq(t *testing.T, h *Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestAuth_ServiceTokenRequerido(t *testing.T) {
	h := newTestStack(t, 0.9, "ok", nil)
	rec := doReq(t, h, "POST", "/api/support/kb/search", `{"query":"retiros"}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin service token esperaba 401, got %d", rec.Code)
	}
}

func TestAuth_AdminExigeEmailVERIFICADO(t *testing.T) {
	// Email admin por header SIN id token verificado ⇒ rol member ⇒ 403.
	// Esta es la regla anti-spoof: la allowlist solo aplica sobre identidad
	// verificada por Cognito.
	h := newTestStack(t, 0.9, "ok", nil)
	rec := doReq(t, h, "GET", "/api/support/kb/docs", "", map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-User-Email":    "devfidubit@gmail.com", // spoofeable ⇒ no basta
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("admin sin verificar esperaba 403, got %d", rec.Code)
	}
}

func TestSearch_VisibilidadPorRol(t *testing.T) {
	var filter map[string]any
	h := newTestStack(t, 0.9, "ok", &filter)

	extract := func() []any {
		must := filter["must"].([]any)
		cond := must[0].(map[string]any)
		return cond["match"].(map[string]any)["any"].([]any)
	}

	// Miembro (email sin verificar cae a member): public+member, NUNCA admin.
	rec := doReq(t, h, "POST", "/api/support/kb/search", `{"query":"retiros"}`, map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-User-Email":    "socio@example.com",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("search member: %d %s", rec.Code, rec.Body)
	}
	vis := extract()
	if len(vis) != 2 || vis[0] != "public" || vis[1] != "member" {
		t.Fatalf("visibilidad member incorrecta: %v", vis)
	}

	// Admin verificado por id token: ve los tres niveles.
	rec = doReq(t, h, "POST", "/api/support/kb/search", `{"query":"retiros"}`, map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-Id-Token":      "ok:devfidubit@gmail.com",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("search admin: %d", rec.Code)
	}
	if vis = extract(); len(vis) != 3 {
		t.Fatalf("visibilidad admin incorrecta: %v", vis)
	}
}

func TestChat_EscalaPorScoreBajo(t *testing.T) {
	h := newTestStack(t, 0.10, "no debería llegar al LLM", nil)
	rec := doReq(t, h, "POST", "/api/support/chat", `{"message":"¿mi retiro de ayer?"}`, map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-User-Email":    "socio@example.com",
	})
	var res ChatResult
	json.NewDecoder(rec.Body).Decode(&res)
	if !res.Escalate {
		t.Fatal("score bajo debía escalar a humano")
	}
}

func TestChat_EscalaPorCentinelaDelLLM(t *testing.T) {
	h := newTestStack(t, 0.9, escalateSentinel, nil)
	rec := doReq(t, h, "POST", "/api/support/chat", `{"message":"algo fuera de la KB"}`, map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-User-Email":    "socio@example.com",
	})
	var res ChatResult
	json.NewDecoder(rec.Body).Decode(&res)
	if !res.Escalate {
		t.Fatal("centinela ESCALAR debía escalar a humano")
	}
}

func TestChat_RespondeConFuentes(t *testing.T) {
	h := newTestStack(t, 0.9, "Los retiros se pagan el día 1 [1].", nil)
	rec := doReq(t, h, "POST", "/api/support/chat", `{"message":"¿cuándo pagan los retiros?"}`, map[string]string{
		"X-VP-Service-Token": "tok-secreto",
		"X-VP-User-Email":    "socio@example.com",
	})
	var res ChatResult
	json.NewDecoder(rec.Body).Decode(&res)
	if res.Escalate {
		t.Fatal("no debía escalar")
	}
	if len(res.Sources) == 0 || res.Sources[0].Titulo != "Política de retiros" {
		t.Fatalf("fuentes incorrectas: %+v", res.Sources)
	}
}
