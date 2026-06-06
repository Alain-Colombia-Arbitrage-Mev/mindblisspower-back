package networkintel

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

func TestHandlerReturnsDeterministicAnalysisWithoutOpenRouterKey(t *testing.T) {
	handler := NewHandler(NewOpenRouterClient(OpenRouterConfig{}), zerolog.Nop())
	payload := []byte(`{
		"metrics": {
			"total_members": 10,
			"active_members": 8,
			"left_members": 2,
			"right_members": 8,
			"left_volume": 1000,
			"right_volume": 5000,
			"company_fund": 5000,
			"projected_outflows": 2000,
			"worst_theta": 0.91
		}
	}`)

	req := httptest.NewRequest(http.MethodPost, "/network/analyze", bytes.NewReader(payload))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp AnalysisResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Provider != "local-network-rules" {
		t.Fatalf("expected deterministic provider, got %s", resp.Provider)
	}
	if resp.WeakLeg != "left" {
		t.Fatalf("expected left weak leg, got %s", resp.WeakLeg)
	}
}
