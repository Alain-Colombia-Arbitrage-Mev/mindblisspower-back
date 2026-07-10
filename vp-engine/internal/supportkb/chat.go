package supportkb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Bot es el RAG de soporte: busca contexto en Qdrant y responde con el LLM de
// chat vía OpenRouter. El modelo de chat es ITERABLE (config) sin tocar los
// embeddings — la razón por la que consolidamos en OpenRouter.
type Bot struct {
	searcher *Searcher
	apiKey   string
	chatURL  string
	model    string
	minScore float64
	http     *http.Client
}

func NewBot(searcher *Searcher, apiKey, chatURL, model string, minScore float64) *Bot {
	return &Bot{
		searcher: searcher,
		apiKey:   apiKey,
		chatURL:  chatURL,
		model:    model,
		minScore: minScore,
		http:     &http.Client{Timeout: 60 * time.Second},
	}
}

// ChatResult es la respuesta del bot. Escalate=true ⇒ el frontend deriva la
// conversación a un agente humano (Chatwoot).
type ChatResult struct {
	Answer   string `json:"answer"`
	Sources  []Hit  `json:"sources"`
	Escalate bool   `json:"escalate"`
}

// Centinela que el system prompt obliga a emitir cuando el contexto no alcanza.
const escalateSentinel = "ESCALAR"

const systemPrompt = `Eres el asistente de soporte de MindblissPower. Respondes SOLO con la información del CONTEXTO proporcionado, en español, de forma breve y precisa.

Reglas estrictas:
- Si el contexto no contiene la respuesta, responde exactamente: ` + escalateSentinel + `
- NUNCA inventes cifras, fechas, montos ni políticas.
- NUNCA respondas sobre el estado de cuenta, pagos o retiros específicos de una persona: eso lo resuelve un agente (responde ` + escalateSentinel + `).
- Cita la fuente con [n] usando el número del fragmento del contexto.`

// Chat responde una pregunta de soporte con RAG. role viene del middleware de
// identidad (server-side), nunca del cliente.
func (b *Bot) Chat(ctx context.Context, question, role string) (ChatResult, error) {
	hits, err := b.searcher.Search(ctx, question, SearchOpts{
		Visibility: VisibilityFor(role),
		Lang:       "es",
		TopK:       5,
	})
	if err != nil {
		return ChatResult{}, fmt.Errorf("search: %w", err)
	}

	// Sin contexto relevante ⇒ escalar sin gastar el LLM.
	if len(hits) == 0 || hits[0].Score < b.minScore {
		return ChatResult{
			Answer:   "No tengo esa información a la mano; te conecto con un agente de soporte.",
			Sources:  hits,
			Escalate: true,
		}, nil
	}

	var ctxb strings.Builder
	for i, h := range hits {
		fmt.Fprintf(&ctxb, "[%d] %s (%s)\n%s\n\n", i+1, h.Titulo, h.Categoria, h.Texto)
	}

	answer, err := b.complete(ctx, systemPrompt,
		"CONTEXTO:\n\n"+ctxb.String()+"\nPREGUNTA: "+question)
	if err != nil {
		return ChatResult{}, err
	}

	if strings.Contains(answer, escalateSentinel) {
		return ChatResult{
			Answer:   "Esa consulta la tiene que revisar un agente; te conecto con soporte.",
			Sources:  hits,
			Escalate: true,
		}, nil
	}
	return ChatResult{Answer: answer, Sources: hits}, nil
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

// complete llama a chat/completions de OpenRouter con un retry en 429/5xx.
func (b *Bot) complete(ctx context.Context, system, user string) (string, error) {
	body, err := json.Marshal(chatRequest{
		Model: b.model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: 0.2,
		MaxTokens:   600,
	})
	if err != nil {
		return "", err
	}

	var lastErr error
	for attempt, wait := 0, 2*time.Second; attempt < 2; attempt, wait = attempt+1, wait*2 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(wait):
			}
		}
		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, b.chatURL, bytes.NewReader(body))
		if rerr != nil {
			return "", rerr
		}
		req.Header.Set("Authorization", "Bearer "+b.apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, derr := b.http.Do(req)
		if derr != nil {
			lastErr = derr
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("openrouter chat: status %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			eb, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			return "", fmt.Errorf("openrouter chat: status %d: %s", resp.StatusCode, eb)
		}
		var out chatResponse
		err := json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if err != nil {
			return "", err
		}
		if len(out.Choices) == 0 {
			return "", fmt.Errorf("openrouter chat: respuesta sin choices")
		}
		return strings.TrimSpace(out.Choices[0].Message.Content), nil
	}
	return "", fmt.Errorf("openrouter chat agotó reintentos: %w", lastErr)
}
