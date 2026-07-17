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

// KYC OCR — validación automática de CUALQUIER documento KYC.
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

// DocOCR es la extracción estructurada que devuelve el modelo para CUALQUIER
// tipo de documento KYC (pasaporte, cédula/ID, comprobante de domicilio, selfie).
type DocOCR struct {
	DocumentKind     string  `json:"document_kind"`           // passport|national_id|drivers_license|address_proof|selfie_with_id|other
	IsReadable       bool    `json:"is_readable"`             // la imagen es clara y legible
	Surname          string  `json:"surname"`                 // apellidos (docs de identidad)
	GivenNames       string  `json:"given_names"`             // nombres
	ExpiryDate       string  `json:"expiry_date"`             // vigencia (docs de identidad), YYYY-MM-DD
	HasAddress       bool    `json:"has_address"`             // comprobante de domicilio con dirección
	PersonHoldingDoc bool    `json:"person_holding_document"` // selfie sosteniendo un documento
	Confidence       float64 `json:"confidence"`
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

const ocrSystemPrompt = `Eres un verificador de documentos KYC. Recibes la imagen de un documento y devuelves ÚNICAMENTE un objeto JSON válido, sin texto adicional ni markdown, con exactamente estas claves:
{"document_kind": string, "is_readable": bool, "surname": string, "given_names": string, "expiry_date": "YYYY-MM-DD", "has_address": bool, "person_holding_document": bool, "confidence": number}
Reglas:
- document_kind: clasifica la imagen en uno de: "passport" (pasaporte), "national_id" (cédula/DNI/INE/documento nacional de identidad), "drivers_license" (licencia de conducir), "address_proof" (recibo de servicios o estado de cuenta bancario con dirección), "selfie_with_id" (foto de una persona sosteniendo un documento), "other" (cualquier otra cosa, o ilegible).
- is_readable=true solo si la imagen es clara, real y se pueden leer los datos (no borrosa, no recortada, no una captura de pantalla falsa).
- surname/given_names: apellidos/nombres si es un documento de identidad; si no aplica, "".
- expiry_date: vigencia en ISO YYYY-MM-DD si es visible; si no, "".
- has_address=true si es un comprobante con una dirección física legible.
- person_holding_document=true si se ve claramente a una persona sosteniendo un documento de identidad.
- confidence: 0..1. Si no puedes leer o es sospechosa, is_readable=false y confidence baja.`

// Analyze envía el documento al modelo de visión y devuelve la extracción + el
// JSON crudo. Soporta imágenes (image_url) y PDF (file).
func (k *KYCOCR) Analyze(ctx context.Context, data []byte, mime string) (DocOCR, string, error) {
	if !k.Enabled() {
		return DocOCR{}, "", errors.New("kyc ocr not configured")
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
		return DocOCR{}, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kycOCREndpoint, bytes.NewReader(payload))
	if err != nil {
		return DocOCR{}, "", err
	}
	req.Header.Set("Authorization", "Bearer "+k.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("HTTP-Referer", "https://mindblisspower.com")
	req.Header.Set("X-Title", "MindBliss Power KYC")

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return DocOCR{}, "", err
	}
	defer resp.Body.Close()

	var decoded ocrResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return DocOCR{}, "", fmt.Errorf("ocr decode: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if decoded.Error.Message != "" {
			return DocOCR{}, "", fmt.Errorf("openrouter %s: %s", resp.Status, decoded.Error.Message)
		}
		return DocOCR{}, "", fmt.Errorf("openrouter %s", resp.Status)
	}
	if len(decoded.Choices) == 0 {
		return DocOCR{}, "", errors.New("ocr empty response")
	}
	raw := stripJSONFence(decoded.Choices[0].Message.Content)
	var out DocOCR
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return DocOCR{}, raw, fmt.Errorf("ocr parse: %w", err)
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

// maybeStartDocOCR marca el documento como OCR pendiente y lanza el análisis
// en segundo plano. No-op si el OCR no está configurado.
func (h *Handler) maybeStartDocOCR(docID, personID int64) {
	if h.kyc == nil || h.kycocr == nil || !h.kycocr.Enabled() {
		return
	}
	n, err := h.store.MarkKYCOCRPending(context.Background(), docID, personID)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr mark pending")
		return
	}
	if n == 0 {
		return // ya fue procesado o no está in_review
	}
	go h.runDocOCR(docID, personID)
}

// runDocOCR ejecuta el OCR + validación + transición de estado (best-effort).
func (h *Handler) runDocOCR(docID, personID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()

	// Los fallos TÉCNICOS (doc no encontrado, S3, modelo) NO rechazan al miembro:
	// se deja el doc 'pending' para que el sweep reintente (y se rinde tras un
	// máximo, rechazando solo el DOC, no a la persona).
	doc, err := h.store.KYCDocForOCR(ctx, docID, personID)
	if err != nil {
		if errors.Is(err, ErrKYCDocNotFound) {
			return // el doc no existe (o lag de réplica) → no tocamos a la persona
		}
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr load doc (retryable)")
		_ = h.store.TouchKYCOCRPending(ctx, docID)
		return
	}
	data, err := h.kyc.GetObject(ctx, doc.StorageKey)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr download (retryable)")
		_ = h.store.TouchKYCOCRPending(ctx, docID)
		return
	}
	ocr, raw, err := h.kycocr.Analyze(ctx, data, doc.MimeType)
	if err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr analyze (retryable)")
		_ = h.store.TouchKYCOCRPending(ctx, docID)
		return
	}

	decision, reason, expiry := evaluateDoc(doc.DocType, ocr, doc.FirstName, doc.LastName)
	if err := h.store.FinishKYCOCR(ctx, docID, personID, doc.DocType, decision, reason, expiry, raw); err != nil {
		h.log.Error().Err(err).Int64("doc", docID).Msg("kyc ocr finish")
		return
	}
	h.log.Info().Int64("doc", docID).Str("type", doc.DocType).Str("decision", decision).Str("reason", reason).Msg("kyc ocr done")
}

// evaluateDoc aplica reglas según el TIPO de documento. Cada tipo se valida
// automáticamente (es real/legible y del tipo correcto) y se aprueba o rechaza
// con un motivo claro que permite volver a subir.
// Devuelve ("approved"|"rejected", motivo, expiry).
func evaluateDoc(docType string, ocr DocOCR, firstName, lastName string) (string, string, *time.Time) {
	if !ocr.IsReadable {
		return "rejected", "La imagen no es legible o no parece real. Vuelve a subir una foto clara y completa del documento.", nil
	}

	switch docType {
	case "passport":
		if ocr.DocumentKind != "passport" {
			return "rejected", "El documento no parece ser un pasaporte. Sube la página principal de tu pasaporte.", nil
		}
		return evalIDDoc(ocr, firstName, lastName, "El pasaporte está vencido.", "Los datos del pasaporte no coinciden con tu perfil.")

	case "identity_card":
		if ocr.DocumentKind != "national_id" && ocr.DocumentKind != "drivers_license" && ocr.DocumentKind != "passport" {
			return "rejected", "No parece un documento de identidad válido. Sube tu cédula/DNI (frente y reverso).", nil
		}
		return evalIDDoc(ocr, firstName, lastName, "El documento de identidad está vencido.", "Los datos del documento no coinciden con tu perfil.")

	case "proof_address":
		if ocr.DocumentKind != "address_proof" || !ocr.HasAddress {
			return "rejected", "No parece un comprobante de domicilio con una dirección legible. Sube un recibo o estado de cuenta reciente.", nil
		}
		return "approved", "", nil

	case "selfie":
		if !ocr.PersonHoldingDoc {
			return "rejected", "No se ve una selfie sosteniendo tu documento. Toma una foto tuya sosteniendo tu identificación.", nil
		}
		return "approved", "", nil

	default:
		// Tipo desconocido ⇒ fail-closed (no auto-aprobar).
		return "rejected", "Tipo de documento no reconocido. Sube el documento solicitado.", nil
	}
}

// evalIDDoc valida vigencia + coincidencia de nombre para documentos de identidad.
// Fail-closed: sin nombre en el perfil no se puede verificar identidad ⇒ NO se
// aprueba (se pide completar el nombre antes).
func evalIDDoc(ocr DocOCR, firstName, lastName, expiredMsg, mismatchMsg string) (string, string, *time.Time) {
	expiry, ok := parseOCRDate(ocr.ExpiryDate)
	if !ok {
		// Fail-closed: sin fecha de vencimiento legible no podemos verificar la
		// vigencia ⇒ rechazar (re-subible), no aprobar.
		return "rejected", "No pudimos leer la fecha de vencimiento. Vuelve a subir una foto clara y completa del documento.", nil
	}
	if !expiry.After(time.Now().UTC()) {
		return "rejected", expiredMsg, &expiry
	}
	if strings.TrimSpace(firstName) == "" && strings.TrimSpace(lastName) == "" {
		return "rejected", "Completa tu nombre en tu perfil antes de subir tu documento de identidad.", &expiry
	}
	if !nameMatches(firstName, lastName, ocr.GivenNames, ocr.Surname) {
		return "rejected", mismatchMsg, &expiry
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
	DocType    string
	StorageKey string
	MimeType   string
	FirstName  string
	LastName   string
}

// MarkKYCOCRPending marca CUALQUIER documento in_review como ocr_status='pending'
// (todos los tipos se validan automáticamente por OCR, no solo el pasaporte).
// Devuelve filas afectadas (0 ⇒ ya procesado o no está in_review).
func (s *Store) MarkKYCOCRPending(ctx context.Context, docID, personID int64) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE mlm.kyc_document
		   SET ocr_status = 'pending', updated_at = now()
		 WHERE id = $1 AND person_id = $2
		   AND status = 'in_review' AND ocr_status = 'skipped'
	`, docID, personID)
	if err != nil {
		return 0, fmt.Errorf("mark kyc ocr pending: %w", err)
	}
	return tag.RowsAffected(), nil
}

// KYCDocForOCR devuelve doc_type + storage_key + mime + nombres del titular.
func (s *Store) KYCDocForOCR(ctx context.Context, docID, personID int64) (kycOCRDoc, error) {
	var d kycOCRDoc
	var first, last *string
	err := s.db.QueryRow(ctx, `
		SELECT k.doc_type, k.storage_key, k.mime_type, trim(p.first_name), trim(p.last_name)
		  FROM mlm.kyc_document k
		  JOIN mlm.person p ON p.id = k.person_id
		 WHERE k.id = $1 AND k.person_id = $2
	`, docID, personID).Scan(&d.DocType, &d.StorageKey, &d.MimeType, &first, &last)
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

// primaryIDDoc: tipos que prueban identidad. SOLO estos cambian person.kyc_status
// (un comprobante de domicilio o una selfie NO aprueban/rechazan al miembro; de lo
// contrario cualquier documento débil aprobaría el KYC sin verificar la identidad).
func primaryIDDoc(docType string) bool {
	return docType == "passport" || docType == "identity_card"
}

// FinishKYCOCR aplica el resultado del OCR de un documento de forma transaccional.
// decision: "approved" | "rejected" (decisiones de CONTENIDO; los fallos técnicos
// se reintentan, no llegan aquí). El estado del MIEMBRO (person.kyc_status) solo
// lo cambian los documentos de identidad primaria (pasaporte/cédula).
func (s *Store) FinishKYCOCR(ctx context.Context, docID, personID int64, docType, decision, reason string, expiry *time.Time, rawJSON string) error {
	// Guardamos ocr_result solo si es JSON válido (evita error ::jsonb → rollback).
	var raw any
	if s := strings.TrimSpace(rawJSON); s != "" && json.Valid([]byte(s)) {
		raw = s
	}
	var expiryArg any
	if expiry != nil {
		expiryArg = expiry.Format("2006-01-02")
	}
	primary := primaryIDDoc(docType)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if decision == "approved" {
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.kyc_document
			   SET status='approved', ocr_status='passed', ocr_reason=NULL,
			       ocr_result=$3::jsonb, doc_expiry=$4, ocr_checked_at=now(),
			       reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND person_id=$2
		`, docID, personID, raw, expiryArg); err != nil {
			return fmt.Errorf("ocr approve doc: %w", err)
		}
		if primary {
			if _, err := tx.Exec(ctx, `
				UPDATE mlm.person SET kyc_status='approved', updated_at=now()
				 WHERE id=$1 AND kyc_status <> 'approved'
			`, personID); err != nil {
				return fmt.Errorf("ocr approve person: %w", err)
			}
		}
	} else { // "rejected"
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.kyc_document
			   SET status='rejected', ocr_status='failed', reject_reason=$3, ocr_reason=$3,
			       ocr_result=$4::jsonb, doc_expiry=$5, ocr_checked_at=now(),
			       reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND person_id=$2
		`, docID, personID, reason, raw, expiryArg); err != nil {
			return fmt.Errorf("ocr reject doc: %w", err)
		}
		if primary {
			if _, err := tx.Exec(ctx, `
				UPDATE mlm.person SET kyc_status='rejected', updated_at=now()
				 WHERE id=$1 AND kyc_status NOT IN ('approved')
			`, personID); err != nil {
				return fmt.Errorf("ocr reject person: %w", err)
			}
		}
	}
	return tx.Commit(ctx)
}

// TouchKYCOCRPending bumpea updated_at de un doc pendiente (para espaciar los
// reintentos del sweep ante fallos técnicos, sin rechazar nada).
func (s *Store) TouchKYCOCRPending(ctx context.Context, docID int64) error {
	_, err := s.db.Exec(ctx,
		`UPDATE mlm.kyc_document SET updated_at=now() WHERE id=$1 AND ocr_status='pending'`, docID)
	return err
}

// GiveUpStaleKYCOCR rechaza (re-subible) los documentos que llevan demasiado
// tiempo 'pending' (fallo técnico persistente). NO toca person.kyc_status: un
// problema de infraestructura no debe rechazar al miembro.
func (s *Store) GiveUpStaleKYCOCR(ctx context.Context, maxAge time.Duration) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE mlm.kyc_document
		   SET status='rejected', ocr_status='error',
		       reject_reason='No pudimos verificar tu documento automáticamente. Vuelve a subir una foto clara.',
		       ocr_reason='give up after retries', ocr_checked_at=now(), reviewed_at=now(), updated_at=now()
		 WHERE ocr_status='pending' AND created_at < now() - $1::interval
	`, fmt.Sprintf("%d seconds", int(maxAge.Seconds())))
	if err != nil {
		return 0, fmt.Errorf("give up stale kyc ocr: %w", err)
	}
	return tag.RowsAffected(), nil
}

// PendingKYCOCR es un documento con OCR pendiente (para el sweep de respaldo).
type PendingKYCOCR struct {
	DocID    int64
	PersonID int64
}

// PendingKYCOCRDocs lista documentos con ocr_status='pending' entre minAge y
// maxAge de antigüedad (reintento acotado; los más viejos que maxAge los abandona
// GiveUpStaleKYCOCR). Limita a limit filas.
func (s *Store) PendingKYCOCRDocs(ctx context.Context, minAge, maxAge time.Duration, limit int) ([]PendingKYCOCR, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT id, person_id FROM mlm.kyc_document
		 WHERE ocr_status='pending'
		   AND updated_at < now() - $1::interval
		   AND created_at  > now() - $2::interval
		 ORDER BY created_at
		 LIMIT $3
	`, fmt.Sprintf("%d seconds", int(minAge.Seconds())), fmt.Sprintf("%d seconds", int(maxAge.Seconds())), limit)
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

// RunKYCOCRSweep reprocesa documentos con OCR pendiente (resiliencia a fallos
// técnicos/reinicios). Corre de forma síncrona en una sola goroutine (no se
// solapa). Best-effort; los errores se registran, no se propagan.
func (h *Handler) RunKYCOCRSweep(ctx context.Context) {
	if h.kyc == nil || h.kycocr == nil || !h.kycocr.Enabled() {
		return
	}
	// 1) Rendirse con los pendientes de >20min (fallo técnico persistente):
	//    rechaza solo el DOCUMENTO (re-subible), sin tocar a la persona.
	if n, err := h.store.GiveUpStaleKYCOCR(ctx, 20*time.Minute); err != nil {
		h.log.Error().Err(err).Msg("kyc ocr give up stale")
	} else if n > 0 {
		h.log.Info().Int64("count", n).Msg("kyc ocr gave up on stale docs")
	}
	// 2) Reintentar los recientes (2min–20min), espaciados por updated_at.
	docs, err := h.store.PendingKYCOCRDocs(ctx, 2*time.Minute, 20*time.Minute, 20)
	if err != nil {
		h.log.Error().Err(err).Msg("kyc ocr sweep list")
		return
	}
	for _, d := range docs {
		h.runDocOCR(d.DocID, d.PersonID)
	}
}
