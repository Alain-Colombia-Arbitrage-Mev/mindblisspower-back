package networkintel

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

type Handler struct {
	client *OpenRouterClient
	log    zerolog.Logger
}

func NewHandler(client *OpenRouterClient, log zerolog.Logger) *Handler {
	return &Handler{
		client: client,
		log:    log.With().Str("component", "networkintel").Logger(),
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setJSONHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AnalysisRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		http.Error(w, "invalid analysis payload: "+err.Error(), http.StatusBadRequest)
		return
	}

	baseline := DeterministicAnalysis(req)
	if h.client == nil || !h.client.Enabled() {
		_ = json.NewEncoder(w).Encode(baseline)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	analysis, err := h.client.Analyze(ctx, req, baseline)
	if err != nil {
		h.log.Warn().Err(err).Msg("openrouter analysis failed; returning deterministic analysis")
		baseline.Warnings = append(baseline.Warnings, err.Error())
		_ = json.NewEncoder(w).Encode(baseline)
		return
	}

	_ = json.NewEncoder(w).Encode(analysis)
}

func setJSONHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}
