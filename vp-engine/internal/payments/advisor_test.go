package payments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vicionpower/vp-engine/internal/networkintel"
)

func TestAnalyzeViaEngine_FallbackWhenUnreachable(t *testing.T) {
	req := networkintel.AnalysisRequest{Metrics: networkintel.NetworkMetrics{TotalMembers: 10, ActiveMembers: 8}}
	resp := analyzeViaEngine(context.Background(), "http://127.0.0.1:1/nope", req, &http.Client{Timeout: time.Second})
	if resp.HealthScore == 0 && resp.Provider == "" {
		t.Fatal("esperaba fallback determinístico poblado")
	}
	found := false
	for _, w := range resp.Warnings {
		if strings.Contains(strings.ToLower(w), "engine") {
			found = true
		}
	}
	if !found {
		t.Fatal("esperaba warning de fallback")
	}
}

func TestAnalyzeViaEngine_HappyPath(t *testing.T) {
	want := networkintel.AnalysisResponse{
		Provider:    "openrouter",
		Mode:        "llm",
		HealthScore: 87,
		RiskLevel:   "bajo",
		WeakLeg:     "right",
		Summary:     "Red en buena salud.",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("esperaba POST, got %s", r.Method)
		}
		if r.Header.Get("content-type") != "application/json" {
			t.Errorf("esperaba content-type application/json, got %s", r.Header.Get("content-type"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(want)
	}))
	defer srv.Close()

	req := networkintel.AnalysisRequest{Metrics: networkintel.NetworkMetrics{TotalMembers: 20, ActiveMembers: 15}}
	resp := analyzeViaEngine(context.Background(), srv.URL, req, srv.Client())

	if resp.HealthScore != want.HealthScore {
		t.Errorf("HealthScore: got %d, want %d", resp.HealthScore, want.HealthScore)
	}
	if resp.Provider != want.Provider {
		t.Errorf("Provider: got %q, want %q", resp.Provider, want.Provider)
	}
	if resp.Mode != want.Mode {
		t.Errorf("Mode: got %q, want %q", resp.Mode, want.Mode)
	}
}

func TestAnalyzeViaEngine_FallbackOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	req := networkintel.AnalysisRequest{Metrics: networkintel.NetworkMetrics{TotalMembers: 5, ActiveMembers: 3}}
	resp := analyzeViaEngine(context.Background(), srv.URL, req, srv.Client())

	if resp.Provider == "" {
		t.Fatal("esperaba fallback determinístico con Provider no vacío")
	}
	found := false
	for _, w := range resp.Warnings {
		if strings.Contains(strings.ToLower(w), "engine") {
			found = true
		}
	}
	if !found {
		t.Fatal("esperaba warning de fallback en respuesta no-200")
	}
}

func TestAnalyzeViaEngine_EmptyEngineURL(t *testing.T) {
	req := networkintel.AnalysisRequest{Metrics: networkintel.NetworkMetrics{TotalMembers: 5, ActiveMembers: 3}}
	resp := analyzeViaEngine(context.Background(), "", req, &http.Client{Timeout: time.Second})

	if resp.Provider == "" {
		t.Fatal("esperaba fallback determinístico con Provider no vacío")
	}
	found := false
	for _, w := range resp.Warnings {
		if strings.Contains(strings.ToLower(w), "engine") {
			found = true
		}
	}
	if !found {
		t.Fatal("esperaba warning de fallback cuando engineURL está vacío")
	}
}
