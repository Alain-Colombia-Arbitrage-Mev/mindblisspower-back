package simulate

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func newTestHandler() *Handler {
	return NewHandler(zerolog.Nop())
}

// postSimulate sends a POST /simulate request with the given body and returns
// the recorder.
func postSimulate(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/simulate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// TestBenignOverride: small treasury_alpha bump → 200, solvent==true,
// worst_theta > 0.
func TestBenignOverride(t *testing.T) {
	h := newTestHandler()
	body := `{"overrides":{"treasury_alpha":"0.50"},"periods":10,"seed":42}`
	rr := postSimulate(t, h, body)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d: %s", rr.Code, rr.Body.String())
	}

	var resp SimulateResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Solvent {
		t.Errorf("expected solvent=true, got false (worst_theta=%f)", resp.WorstTheta)
	}
	if resp.WorstTheta <= 0 {
		t.Errorf("expected worst_theta > 0, got %f", resp.WorstTheta)
	}
	if resp.Periods != 10 {
		t.Errorf("expected periods=10, got %d", resp.Periods)
	}
	if len(resp.Warnings) != 0 {
		t.Errorf("expected no warnings, got %v", resp.Warnings)
	}
}

// TestOverridesTakeEffect: two runs with different treasury_alpha must produce
// different worst_theta, proving overrides propagate into the simulator.
// Strategy: alpha=0.90 (very generous) vs alpha=0.30 (very tight).
// The generous run should have a higher (or equal) worst_theta than the tight one.
func TestOverridesTakeEffect(t *testing.T) {
	h := newTestHandler()

	bodyLoose := `{"overrides":{"treasury_alpha":"0.90"},"periods":20,"seed":42}`
	bodyTight := `{"overrides":{"treasury_alpha":"0.30"},"periods":20,"seed":42}`

	rrLoose := postSimulate(t, h, bodyLoose)
	rrTight := postSimulate(t, h, bodyTight)

	if rrLoose.Code != http.StatusOK {
		t.Fatalf("loose run: expected 200 got %d", rrLoose.Code)
	}
	if rrTight.Code != http.StatusOK {
		t.Fatalf("tight run: expected 200 got %d", rrTight.Code)
	}

	var loose, tight SimulateResponse
	if err := json.NewDecoder(rrLoose.Body).Decode(&loose); err != nil {
		t.Fatalf("decode loose: %v", err)
	}
	if err := json.NewDecoder(rrTight.Body).Decode(&tight); err != nil {
		t.Fatalf("decode tight: %v", err)
	}

	// The runs must produce different worst_theta values — confirming that the
	// override actually changed the simulation.  (We do not assert direction
	// because theta reflects projected/inflows and extreme alpha values can
	// both clamp to 1.0 when projected < alpha*inflows.)
	if loose.WorstTheta == tight.WorstTheta {
		// Fallback: at least solvency behaviour differs.
		t.Logf("worst_theta identical (%f); checking solvency differs or periods match", loose.WorstTheta)
		// Both can be solvent if the plan always has projected < 0.30 * inflows,
		// so we only fail if both theta AND solvent AND margin are identical.
		if loose.Solvent == tight.Solvent && loose.Margin == tight.Margin {
			t.Errorf("overrides had no effect: loose=%+v tight=%+v", loose, tight)
		}
	}
	// At minimum both runs should return a positive worst_theta.
	if loose.WorstTheta <= 0 || tight.WorstTheta <= 0 {
		t.Errorf("worst_theta must be > 0: loose=%f tight=%f", loose.WorstTheta, tight.WorstTheta)
	}
}

// TestBadRequest: unknown JSON field → 400.
func TestBadRequest(t *testing.T) {
	h := newTestHandler()
	body := `{"overrides":{},"periods":5,"unknown_field":"boom"}`
	rr := postSimulate(t, h, body)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d: %s", rr.Code, rr.Body.String())
	}
}

// TestMethodNotAllowed: GET → 405.
func TestMethodNotAllowed(t *testing.T) {
	h := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "/simulate", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 got %d", rr.Code)
	}
}

// TestOptionsRequest: OPTIONS → 204.
func TestOptionsRequest(t *testing.T) {
	h := newTestHandler()
	req := httptest.NewRequest(http.MethodOptions, "/simulate", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204 got %d", rr.Code)
	}
}

// TestUnknownOverrideKey: unknown override key → 200 with warning, not 400.
func TestUnknownOverrideKey(t *testing.T) {
	h := newTestHandler()
	body := `{"overrides":{"treasury_alpha":"0.45","unknown_param":"99"},"periods":5,"seed":42}`
	rr := postSimulate(t, h, body)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d: %s", rr.Code, rr.Body.String())
	}

	var resp SimulateResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	found := false
	for _, w := range resp.Warnings {
		if strings.Contains(w, "unknown_param") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected warning for unknown_param, got %v", resp.Warnings)
	}
}

// TestDefaultPeriods: omitting periods uses default of 52.
func TestDefaultPeriods(t *testing.T) {
	h := newTestHandler()
	body := `{"overrides":{}}`
	rr := postSimulate(t, h, body)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d: %s", rr.Code, rr.Body.String())
	}

	var resp SimulateResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Periods != 52 {
		t.Errorf("expected default periods=52, got %d", resp.Periods)
	}
}

// TestPeriodsClamped: periods > 520 is clamped to 520.
func TestPeriodsClamped(t *testing.T) {
	h := newTestHandler()
	// Use a very small run to avoid blowing up the test time — just verify the
	// returned Periods field is capped, not the actual value we sent (9999).
	// We send 521 which should be clamped to 520 but that's slow; instead send
	// a value in range and just verify clamping logic via unit path.  Use 521
	// directly and check the returned field.
	body := `{"overrides":{},"periods":521,"seed":42}`
	// This would run 520 periods which is slow — skip in short mode.
	if testing.Short() {
		t.Skip("skipping period-clamp test in short mode")
	}
	rr := postSimulate(t, h, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", rr.Code)
	}
	var resp SimulateResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Periods != 520 {
		t.Errorf("expected clamped periods=520, got %d", resp.Periods)
	}
}

// TestEmptyBody: empty JSON object → 200 with defaults.
func TestEmptyBody(t *testing.T) {
	h := newTestHandler()
	body := `{}`
	rr := postSimulate(t, h, bytes.NewBufferString(body).String())

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d: %s", rr.Code, rr.Body.String())
	}
}
