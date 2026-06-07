package networkintel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultModel         = "xiaomi/mimo-v2.5-pro"
	DefaultFallbackModel = "minimax/minimax-m3"
	DefaultEndpoint      = "https://openrouter.ai/api/v1/chat/completions"
)

type OpenRouterConfig struct {
	APIKey        string
	Model         string
	FallbackModel string
	Endpoint      string
	Referer       string
	AppTitle      string
}

type OpenRouterClient struct {
	cfg        OpenRouterConfig
	httpClient *http.Client
}

func NewOpenRouterClient(cfg OpenRouterConfig) *OpenRouterClient {
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.FallbackModel == "" {
		cfg.FallbackModel = DefaultFallbackModel
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = DefaultEndpoint
	}
	return &OpenRouterClient{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 35 * time.Second,
		},
	}
}

func (c *OpenRouterClient) Enabled() bool {
	return c != nil && strings.TrimSpace(c.cfg.APIKey) != ""
}

func (c *OpenRouterClient) Analyze(ctx context.Context, req AnalysisRequest, baseline AnalysisResponse) (AnalysisResponse, error) {
	if !c.Enabled() {
		return baseline, errors.New("openrouter api key is not configured")
	}

	models := []string{c.cfg.Model}
	if c.cfg.FallbackModel != "" && c.cfg.FallbackModel != c.cfg.Model {
		models = append(models, c.cfg.FallbackModel)
	}

	var lastErr error
	for _, model := range models {
		resp, err := c.call(ctx, model, req, baseline)
		if err == nil {
			return resp, nil
		}
		lastErr = err
	}
	return baseline, lastErr
}

func (c *OpenRouterClient) call(ctx context.Context, model string, req AnalysisRequest, baseline AnalysisResponse) (AnalysisResponse, error) {
	body := openRouterRequest{
		Model: model,
		Messages: []openRouterMessage{
			{
				Role:    "system",
				Content: systemPrompt(),
			},
			{
				Role:    "user",
				Content: userPrompt(req, baseline),
			},
		},
		Temperature: 0.2,
		MaxTokens:   1200,
		ResponseFormat: map[string]string{
			"type": "json_object",
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return AnalysisResponse{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint, bytes.NewReader(payload))
	if err != nil {
		return AnalysisResponse{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")
	if c.cfg.Referer != "" {
		httpReq.Header.Set("HTTP-Referer", c.cfg.Referer)
	}
	if c.cfg.AppTitle != "" {
		httpReq.Header.Set("X-OpenRouter-Title", c.cfg.AppTitle)
	}

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return AnalysisResponse{}, err
	}
	defer httpResp.Body.Close()

	var decoded openRouterResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&decoded); err != nil {
		return AnalysisResponse{}, err
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		if decoded.Error.Message != "" {
			return AnalysisResponse{}, fmt.Errorf("openrouter %s: %s", httpResp.Status, decoded.Error.Message)
		}
		return AnalysisResponse{}, fmt.Errorf("openrouter %s", httpResp.Status)
	}
	if len(decoded.Choices) == 0 {
		return AnalysisResponse{}, errors.New("openrouter returned no choices")
	}

	var analysis AnalysisResponse
	content := extractJSON(decoded.Choices[0].Message.Content)
	if err := json.Unmarshal([]byte(content), &analysis); err != nil {
		return AnalysisResponse{}, fmt.Errorf("openrouter invalid analysis json: %w", err)
	}
	analysis.Provider = "openrouter"
	analysis.Model = decoded.Model
	if analysis.Model == "" {
		analysis.Model = model
	}
	analysis.Mode = "llm"
	analysis.WeakLeg = normalizeLeg(analysis.WeakLeg, baseline.WeakLeg)
	if analysis.HealthScore <= 0 {
		analysis.HealthScore = baseline.HealthScore
	}
	if analysis.RiskLevel == "" {
		analysis.RiskLevel = baseline.RiskLevel
	}
	if analysis.Summary == "" {
		analysis.Summary = baseline.Summary
	}
	if decoded.Usage.TotalTokens > 0 {
		analysis.Usage = &TokenUsage{
			PromptTokens:     decoded.Usage.PromptTokens,
			CompletionTokens: decoded.Usage.CompletionTokens,
			TotalTokens:      decoded.Usage.TotalTokens,
			Cost:             decoded.Usage.Cost,
		}
	}
	return analysis, nil
}

// extractJSON desenvuelve el objeto JSON cuando el modelo lo rodea de texto o
// de cercas markdown (```json ... ```). Toma desde el primer '{' hasta el
// último '}', que es robusto para respuestas de LLM con preámbulo o fences.
func extractJSON(raw string) string {
	s := strings.TrimSpace(raw)
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

func systemPrompt() string {
	return `Eres un analista operativo de red binaria para Vicion Power.
Devuelve solo JSON valido. No prometas ingresos. No inventes pagos.
Usa los calculos deterministas como fuente de verdad y aporta lectura estrategica.
La respuesta debe tener esta forma:
{
  "health_score": 0-100,
  "risk_level": "bajo|medio|alto",
  "weak_leg": "left|right|balanced",
  "summary": "maximo 280 caracteres",
  "predictions": [{"label":"","horizon":"","direction":"mejora|estable|deterioro","score":0.0,"reason":""}],
  "findings": [{"severity":"normal|media|alta","area":"","title":"","detail":""}],
  "actions": [{"priority":"normal|media|alta","title":"","detail":"","target":""}]
}`
}

func userPrompt(req AnalysisRequest, baseline AnalysisResponse) string {
	data, _ := json.MarshalIndent(map[string]any{
		"network_request":        req,
		"deterministic_baseline": baseline,
	}, "", "  ")
	return string(data)
}

func normalizeLeg(value, fallback string) string {
	switch strings.ToLower(value) {
	case "left", "right", "balanced":
		return strings.ToLower(value)
	default:
		return fallback
	}
}

type openRouterRequest struct {
	Model          string              `json:"model"`
	Messages       []openRouterMessage `json:"messages"`
	Temperature    float64             `json:"temperature"`
	MaxTokens      int                 `json:"max_tokens"`
	ResponseFormat any                 `json:"response_format,omitempty"`
}

type openRouterMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openRouterResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int     `json:"prompt_tokens"`
		CompletionTokens int     `json:"completion_tokens"`
		TotalTokens      int     `json:"total_tokens"`
		Cost             float64 `json:"cost"`
	} `json:"usage"`
	Error struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	} `json:"error"`
}
