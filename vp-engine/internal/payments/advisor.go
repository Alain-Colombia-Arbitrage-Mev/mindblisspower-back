package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/vicionpower/vp-engine/internal/networkintel"
)

// analyzeViaEngine llama al endpoint /network/analyze de vp-engine y devuelve
// la respuesta del asesor LLM. Si engineURL está vacío, el motor es inalcanzable,
// devuelve un status != 200, o falla la decodificación, devuelve el veredicto
// determinístico local con un warning adjunto (Option B: vp-payments nunca
// necesita credenciales propias de OpenRouter).
func analyzeViaEngine(ctx context.Context, engineURL string, req networkintel.AnalysisRequest, httpClient *http.Client) networkintel.AnalysisResponse {
	fallback := func() networkintel.AnalysisResponse {
		base := networkintel.DeterministicAnalysis(req)
		base.Warnings = append(base.Warnings, "no se pudo contactar el asesor LLM (vp-engine); veredicto determinístico")
		return base
	}

	if engineURL == "" {
		return fallback()
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fallback()
	}

	url := strings.TrimRight(engineURL, "/") + "/network/analyze"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fallback()
	}
	httpReq.Header.Set("content-type", "application/json")

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return fallback()
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fallback()
	}

	var result networkintel.AnalysisResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fallback()
	}

	return result
}
