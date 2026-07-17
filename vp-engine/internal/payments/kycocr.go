package payments

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// KYC OCR — filtro de validación automática de pasaportes.
// Al confirmar un documento doc_type='passport', se descarga de S3 y se envía a
// un modelo de visión (OpenRouter) que extrae los campos. Si es un pasaporte,
// está vigente y el nombre coincide con la persona ⇒ el KYC se AUTO-APRUEBA.
// Fallo de reglas o error del modelo/ilegible ⇒ RECHAZADO con motivo claro para
// que el miembro pueda volver a subir el documento (habilita re-subida).

const kycOCREndpoint = "https://openrouter.ai/api/v1/chat/completions"

// DefaultKYCOCRModel: modelo de visión por defecto (barato, imagen+PDF, JSON).
const DefaultKYCOCRModel = "google/gemini-3.1-flash-lite"

// KYCOCR es el cliente del modelo de visión para OCR de documentos.
type KYCOCR struct {
	apiKey     string
	model      string
	httpClient *http.Client
}

// NewKYCOCR crea el cliente. apiKey vacío ⇒ Enabled()=false (OCR desactivado).
func NewKYCOCR(apiKey, model string) *KYCOCR {
	if strings.TrimSpace(model) == "" {
		model = DefaultKYCOCRModel
	}
	return &KYCOCR{
		apiKey:     strings.TrimSpace(apiKey),
		model:      model,
		httpClient: &http.Client{Timeout: 55 * time.Second},
	}
}

// Enabled indica si el OCR está configurado (hay API key).
func (k *KYCOCR) Enabled() bool { return k != nil && k.apiKey != "" }

// SetKYCOCR inyecta el cliente OCR. nil ⇒ los pasaportes quedan in_review manual.
func (h *Handler) SetKYCOCR(k *KYCOCR) { h.kycocr = k }

// PassportOCR es la extracción estructurada que devuelve el modelo.
type PassportOCR struct {
	IsPassport   bool    `json:"is_passport"`
	DocumentType string  `json:"document_type"`
	Surname      string  `json:"surname"`
	GivenNames   string  `json:"given_names"`
	PassportNo   string  `json:"passport_number"`
	Nationality  string  `json:"nationality"`
	DateOfBirth  string  `json:"date_of_birth"`
	ExpiryDate   string  `json:"expiry_date"`
	MRZPresent   bool    `json:"mrz_present"`
	Confidence   float64 `json:"confidence"`
}

// ── OpenRouter (visión) ──────────────────────────────────────────────────────

type ocrContent struct {
	Type     string      `json:"type"`
	Text     string      `json:"text,omitempty"`
	ImageURL *ocrURL     `json:"image_url,omitempty"`
	File     *ocrFileObj `json:"file,omitempty"`
}
type ocrURL struct {
	URL string `json:"url"`
}
type ocrFileObj struct {
	Filename string `json:"filename"`
	FileData string `json:"file_data"`
}
type ocrMessage struct {
	Role    string       `json:"role"`
	Content []ocrContent `json:"content"`
}
type ocrRequest struct {
	Model          string         `json:"model"`
	Messages       []ocrMessage   `json:"messages"`
	Temperature    float64        `json:"temperature"`
	MaxTokens      int            `json:"max_tokens"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
}
type ocrResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

const ocrSystemPrompt = `Eres un verificador de documentos de identidad. Recibes la imagen de un documento y devuelves ÚNICAMENTE un objeto JSON válido, sin texto adicional ni markdown, con exactamente estas claves:
{"is_passport": bool, "document_type": string, "surname": string, "given_names": string, "passport_number": string, "nationality": string, "date_of_birth": "YYYY-MM-DD", "expiry_date": "YYYY-MM-DD", "mrz_present": bool, "confidence": number}
Reglas: is_passport=true solo si el documento es claramente un pasaporte (no cédula, licencia u otro). Usa el formato ISO YYYY-MM-DD para las fechas; si una fecha no es legible, usa "". surname = apellidos, given_names = nombres. Si no puedes leer el documento, pon is_passport=false y confidence baja.`

// Analyze envía el documento al modelo de visión y devuelve la extracción + el
// JSON crudo. Soporta imágenes (image_url) y PDF (file).
func (k *KYCOCR) Analyze(ctx context.Context, data []byte, mime string) (PassportOCR, string, error) {
	if !k.Enabled() {
		return PassportOCR{}, "", errors.New("kyc ocr not configured")
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	dataURL := fmt.Sprintf("data:%s;base64,%s", mime, b64)

	parts := []ocrContent{{Type: "text", Text: "Analiza este documento y devuelve el JSON solicitado."}}
	if mime == "application/pdf" {
		parts = append(parts, ocrContent{Type: "file", File: &ocrFileObj{Filename: "document.pdf", FileData: dataURL}})
	} else {
		parts = append(parts, ocrContent{Type: "image_url", ImageURL: &ocrURL{URL: dataURL}})
	}

	body := ocrRequest{
		Model: k.model,
		Messages: []ocrMessage{
			{Role: "system", Content: []ocrContent{{Type: "text", Text: ocrSystemPrompt}}},
			{Role: "user", Content: parts},
		},
		Temperature:    0,
		MaxTokens:      500,
		ResponseFormat: map[string]any{"type": "json_object"},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return PassportOCR{}, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kycOCREndpoint, bytes.NewReader(payload))
	if err != nil {
		return PassportOCR{}, "", err
	}
	req.Header.Set("Authorization", "Bearer "+k.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("HTTP-Referer", "https://mindblisspower.com")
	req.Header.Set("X-Title", "MindBliss Power KYC")

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return PassportOCR{}, "", err
	}
	defer resp.Body.Close()

	var decoded ocrResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return PassportOCR{}, "", fmt.Errorf("ocr decode: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if decoded.Error.Message != "" {
			return PassportOCR{}, "", fmt.Errorf("openrouter %s: %s", resp.Status, decoded.Error.Message)
		}
		return PassportOCR{}, "", fmt.Errorf("openrouter %s", resp.Status)
	}
	if len(decoded.Choices) == 0 {
		return PassportOCR{}, "", errors.New("ocr empty response")
	}
	raw := stripJSONFence(decoded.Choices[0].Message.Content)
	var out PassportOCR
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return PassportOCR{}, raw, fmt.Errorf("ocr parse: %w", err)
	}
	return out, raw, nil
}

// stripJSONFence quita fences markdown (```json ... ```) por si el modelo los añade.
func stripJSONFence(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}

// ── Orquestación ─────────────────────────────────────────────────────────────

// maybeStartPassportOCR marca el pasaporte como OCR pendiente y lanza el análisis
// en segundo plano. No-op si el OCR no está configurado o el doc no es pasaporte.
func (h *Handler) maybeStartPassportOCR(docID, personID int64) {
	if h.kyc == nil || h.kycocr == nil || !h.kycocr.Enabled() {
		return
	}
	n, err := h.store.MarkKYCOCRPending(context.Background(), docID, personID)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr mark pending")
		return
	}
	if n == 0 {
		return // no es pasaporte o ya fue procesado
	}
	go h.runPassportOCR(docID, personID)
}

// runPassportOCR ejecuta el OCR + validación + transición de estado (best-effort).
func (h *Handler) runPassportOCR(docID, personID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()

	doc, err := h.store.KYCDocForOCR(ctx, docID, personID)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr load doc")
		_ = h.store.FinishKYCOCR(ctx, docID, personID, "error", "No pudimos procesar el documento. Vuelve a intentarlo.", nil, "")
		return
	}
	data, err := h.kyc.GetObject(ctx, doc.StorageKey)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr download")
		_ = h.store.FinishKYCOCR(ctx, docID, personID, "error", "No pudimos leer el archivo. Vuelve a subirlo.", nil, "")
		return
	}
	ocr, raw, err := h.kycocr.Analyze(ctx, data, doc.MimeType)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr analyze")
		_ = h.store.FinishKYCOCR(ctx, docID, personID, "error", "No pudimos verificar tu pasaporte automáticamente. Vuelve a subir una foto clara y vigente.", nil, raw)
		return
	}

	decision, reason, expiry := evaluatePassport(ocr, doc.FirstName, doc.LastName)
	if err := h.store.FinishKYCOCR(ctx, docID, personID, decision, reason, expiry, raw); err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr finish")
		return
	}
	h.log.Info().Int64("doc", docID).Str("decision", decision).Str("reason", reason).Msg("kyc ocr done")
}

// evaluatePassport aplica las reglas: es pasaporte + vigente + nombre coincide.
// Devuelve ("approved"|"rejected"|"error", motivo, expiry).
func evaluatePassport(ocr PassportOCR, firstName, lastName string) (string, string, *time.Time) {
	if !ocr.IsPassport {
		return "rejected", "El documento no parece ser un pasaporte.", nil
	}
	expiry, ok := parseOCRDate(ocr.ExpiryDate)
	if !ok {
		return "error", "No pudimos leer la fecha de vencimiento. Vuelve a subir una foto clara del pasaporte.", nil
	}
	if !expiry.After(time.Now().UTC()) {
		return "rejected", "El pasaporte está vencido.", &expiry
	}
	if strings.TrimSpace(firstName) == "" && strings.TrimSpace(lastName) == "" {
		return "error", "Completa tu nombre en el perfil y vuelve a subir el pasaporte.", &expiry
	}
	if !nameMatches(firstName, lastName, ocr.GivenNames, ocr.Surname) {
		return "rejected", "Los datos del pasaporte no coinciden con tu perfil.", &expiry
	}
	return "approved", "", &expiry
}

func parseOCRDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", "02/01/2006", "2006/01/02", "02-01-2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// nameMatches compara el nombre/apellido del perfil con lo extraído del pasaporte
// (insensible a mayúsculas y acentos). Requiere que el primer nombre y el
// apellido del perfil aparezcan en los campos correspondientes del documento.
func nameMatches(firstName, lastName, givenNames, surname string) bool {
	nf := normalizeName(firstName)
	nl := normalizeName(lastName)
	ng := normalizeName(givenNames)
	ns := normalizeName(surname)
	full := strings.TrimSpace(ng + " " + ns)

	lastOK := nl == "" || strings.Contains(ns, nl) || strings.Contains(full, nl)

	firstOK := nf == ""
	if !firstOK {
		if tok := firstToken(nf); tok != "" {
			firstOK = strings.Contains(ng, tok) || strings.Contains(full, tok)
		}
	}
	return lastOK && firstOK
}

func firstToken(s string) string {
	if i := strings.IndexByte(s, ' '); i > 0 {
		return s[:i]
	}
	return s
}

// normalizeName pasa a minúsculas, pliega acentos comunes (español) y colapsa
// espacios, dejando solo letras y espacios.
func normalizeName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	repl := strings.NewReplacer(
		"á", "a", "à", "a", "ä", "a", "â", "a", "ã", "a",
		"é", "e", "è", "e", "ë", "e", "ê", "e",
		"í", "i", "ì", "i", "ï", "i", "î", "i",
		"ó", "o", "ò", "o", "ö", "o", "ô", "o", "õ", "o",
		"ú", "u", "ù", "u", "ü", "u", "û", "u",
		"ñ", "n", "ç", "c",
	)
	s = repl.Replace(s)
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
			prevSpace = false
		case r == ' ' || r == '\t':
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}

// ── Store ────────────────────────────────────────────────────────────────────

// kycOCRDoc son los datos del documento + persona para correr el OCR.
type kycOCRDoc struct {
	StorageKey string
	MimeType   string
	FirstName  string
	LastName   string
}

// MarkKYCOCRPending marca el pasaporte in_review como ocr_status='pending'.
// Devuelve filas afectadas (0 ⇒ no es pasaporte o ya procesado).
func (s *Store) MarkKYCOCRPending(ctx context.Context, docID, personID int64) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE mlm.kyc_document
		   SET ocr_status = 'pending', updated_at = now()
		 WHERE id = $1 AND person_id = $2
		   AND doc_type = 'passport' AND status = 'in_review' AND ocr_status = 'skipped'
	`, docID, personID)
	if err != nil {
		return 0, fmt.Errorf("mark kyc ocr pending: %w", err)
	}
	return tag.RowsAffected(), nil
}

// KYCDocForOCR devuelve storage_key + mime + nombres del titular.
func (s *Store) KYCDocForOCR(ctx context.Context, docID, personID int64) (kycOCRDoc, error) {
	var d kycOCRDoc
	var first, last *string
	err := s.db.QueryRow(ctx, `
		SELECT k.storage_key, k.mime_type, trim(p.first_name), trim(p.last_name)
		  FROM mlm.kyc_document k
		  JOIN mlm.person p ON p.id = k.person_id
		 WHERE k.id = $1 AND k.person_id = $2
	`, docID, personID).Scan(&d.StorageKey, &d.MimeType, &first, &last)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrKYCDocNotFound
	}
	if err != nil {
		return d, fmt.Errorf("kyc doc for ocr: %w", err)
	}
	if first != nil {
		d.FirstName = *first
	}
	if last != nil {
		d.LastName = *last
	}
	return d, nil
}

// FinishKYCOCR aplica el resultado del OCR de forma transaccional.
// decision: "approved" | "rejected" | "error".
func (s *Store) FinishKYCOCR(ctx context.Context, docID, personID int64, decision, reason string, expiry *time.Time, rawJSON string) error {
	var raw any
	if strings.TrimSpace(rawJSON) != "" {
		raw = rawJSON // jsonb acepta el texto JSON directamente
	}
	var expiryArg any
	if expiry != nil {
		expiryArg = expiry.Format("2006-01-02")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	switch decision {
	case "approved":
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.kyc_document
			   SET status='approved', ocr_status='passed', ocr_reason=NULL,
			       ocr_result=$3::jsonb, doc_expiry=$4, ocr_checked_at=now(),
			       reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND person_id=$2
		`, docID, personID, raw, expiryArg); err != nil {
			return fmt.Errorf("ocr approve doc: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.person SET kyc_status='approved', updated_at=now()
			 WHERE id=$1 AND kyc_status <> 'approved'
		`, personID); err != nil {
			return fmt.Errorf("ocr approve person: %w", err)
		}
	case "rejected":
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.kyc_document
			   SET status='rejected', ocr_status='failed', reject_reason=$3, ocr_reason=$3,
			       ocr_result=$4::jsonb, doc_expiry=$5, ocr_checked_at=now(),
			       reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND person_id=$2
		`, docID, personID, reason, raw, expiryArg); err != nil {
			return fmt.Errorf("ocr reject doc: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.person SET kyc_status='rejected', updated_at=now()
			 WHERE id=$1 AND kyc_status NOT IN ('approved')
		`, personID); err != nil {
			return fmt.Errorf("ocr reject person: %w", err)
		}
	default: // "error" ⇒ no se pudo validar automáticamente. Se RECHAZA (no se
		// deja en in_review) para que el miembro pueda volver a subir el documento.
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.kyc_document
			   SET status='rejected', ocr_status='error', reject_reason=$3, ocr_reason=$3,
			       ocr_result=$4::jsonb, ocr_checked_at=now(), reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND person_id=$2
		`, docID, personID, reason, raw); err != nil {
			return fmt.Errorf("ocr error doc: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.person SET kyc_status='rejected', updated_at=now()
			 WHERE id=$1 AND kyc_status NOT IN ('approved')
		`, personID); err != nil {
			return fmt.Errorf("ocr error person: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// PendingKYCOCR es un documento con OCR pendiente (para el sweep de respaldo).
type PendingKYCOCR struct {
	DocID    int64
	PersonID int64
}

// PendingKYCOCRDocs lista documentos con ocr_status='pending' más viejos que
// minAge (para reprocesar tras un reinicio). Limita a limit filas.
func (s *Store) PendingKYCOCRDocs(ctx context.Context, minAge time.Duration, limit int) ([]PendingKYCOCR, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT id, person_id FROM mlm.kyc_document
		 WHERE ocr_status='pending' AND updated_at < now() - $1::interval
		 ORDER BY created_at
		 LIMIT $2
	`, fmt.Sprintf("%d seconds", int(minAge.Seconds())), limit)
	if err != nil {
		return nil, fmt.Errorf("pending kyc ocr: %w", err)
	}
	defer rows.Close()
	var out []PendingKYCOCR
	for rows.Next() {
		var p PendingKYCOCR
		if err := rows.Scan(&p.DocID, &p.PersonID); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// RunKYCOCRSweep reprocesa pasaportes con OCR pendiente atascados (resiliencia a
// reinicios). Best-effort; los errores se registran, no se propagan.
func (h *Handler) RunKYCOCRSweep(ctx context.Context) {
	if h.kyc == nil || h.kycocr == nil || !h.kycocr.Enabled() {
		return
	}
	docs, err := h.store.PendingKYCOCRDocs(ctx, 2*time.Minute, 20)
	if err != nil {
		h.log.Error().Err(err).Msg("kyc ocr sweep list")
		return
	}
	for _, d := range docs {
		h.runPassportOCR(d.DocID, d.PersonID)
	}
}
