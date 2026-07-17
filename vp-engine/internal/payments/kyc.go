package payments

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

// KYC — subida de documentos de identidad del miembro.
// Flujo: el BFF pide una URL presignada de PUT (upload-url) → el navegador sube
// el archivo directo a S3 (el binario nunca pasa por este servicio) → el BFF
// confirma (confirm) y el documento queda in_review; mlm.person.kyc_status
// pasa a in_review. La aprobación/rechazo es de admin (fase posterior).

const (
	kycMaxSizeBytes  = 15 << 20 // 15 MB — debe coincidir con el CHECK de mlm.kyc_document
	kycPresignPutTTL = 15 * time.Minute
)

var (
	kycDocTypes = map[string]bool{
		"identity_card": true,
		"passport":      true,
		"proof_address": true,
		"selfie":        true,
	}
	kycMimeTypes = map[string]bool{
		"application/pdf": true,
		"image/jpeg":      true,
		"image/png":       true,
	}
	kycNameSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

	ErrKYCDocNotFound = errors.New("kyc document not found")
)

// KYCS3 encapsula el presignado y verificación de objetos en el bucket KYC.
type KYCS3 struct {
	bucket  string
	client  *s3.Client
	presign *s3.PresignClient
}

// NewKYCS3 crea el cliente S3 con la cadena de credenciales estándar
// (env → shared config → rol de instancia IMDS).
func NewKYCS3(ctx context.Context, bucket, region string) (*KYCS3, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	client := s3.NewFromConfig(awsCfg)
	return &KYCS3{bucket: bucket, client: client, presign: s3.NewPresignClient(client)}, nil
}

// PresignPut devuelve una URL presignada para subir el objeto con PUT.
func (k *KYCS3) PresignPut(ctx context.Context, key, mime string, size int64) (string, error) {
	req, err := k.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(k.bucket),
		Key:           aws.String(key),
		ContentType:   aws.String(mime),
		ContentLength: aws.Int64(size),
	}, s3.WithPresignExpires(kycPresignPutTTL))
	if err != nil {
		return "", fmt.Errorf("presign put: %w", err)
	}
	return req.URL, nil
}

// ObjectSize verifica que el objeto exista y devuelve su tamaño real.
func (k *KYCS3) ObjectSize(ctx context.Context, key string) (int64, error) {
	head, err := k.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(k.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return 0, err
	}
	return aws.ToInt64(head.ContentLength), nil
}

// GetObject descarga el contenido del objeto (para el OCR). Limita la lectura a
// kycMaxSizeBytes por seguridad.
func (k *KYCS3) GetObject(ctx context.Context, key string) ([]byte, error) {
	out, err := k.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(k.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, kycMaxSizeBytes+1))
}

// SetKYC inyecta el cliente S3 de KYC. nil ⇒ endpoints KYC responden 503.
func (h *Handler) SetKYC(k *KYCS3) { h.kyc = k }

// sanitizeKYCFileName reduce el nombre a un token seguro para la clave S3.
func sanitizeKYCFileName(name string) string {
	base := path.Base(strings.ReplaceAll(strings.TrimSpace(name), "\\", "/"))
	base = kycNameSanitizer.ReplaceAllString(base, "_")
	base = strings.Trim(base, "._-")
	if base == "" {
		base = "document"
	}
	if len(base) > 80 {
		base = base[len(base)-80:]
	}
	return base
}

// validateKYCUpload valida los metadatos declarados antes de presignar.
func validateKYCUpload(docType, fileName, mime string, size int64) string {
	if !kycDocTypes[docType] {
		return "invalid-doc-type"
	}
	if !kycMimeTypes[mime] {
		return "invalid-mime"
	}
	if size <= 0 || size > kycMaxSizeBytes {
		return "invalid-size"
	}
	if strings.TrimSpace(fileName) == "" {
		return "invalid-file-name"
	}
	return ""
}

type kycUploadURLRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`  // del id token — para auto-provisión de mlm.person
	Phone    string `json:"phone"` // del id token
	DocType  string `json:"doc_type"`
	FileName string `json:"file_name"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
}

// handleKYCUploadURL registra el documento (pending_upload) y devuelve la URL
// presignada de PUT. Lo llama el BFF Next con token de servicio.
func (h *Handler) handleKYCUploadURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req kycUploadURLRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid-json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if h.kyc == nil {
		writeErr(w, http.StatusServiceUnavailable, "kyc-unconfigured")
		return
	}
	if msg := validateKYCUpload(req.DocType, req.FileName, req.Mime, req.Size); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	// Auto-provisión: un usuario registrado en Cognito que aún no compró no tiene
	// fila mlm.person, y el KYC (identidad) debe poder hacerse ANTES de comprar.
	// EnsurePerson es idempotente (solo lee si ya existe), así que no bloqueamos.
	if _, err := h.store.EnsurePerson(r.Context(), email, req.Name, req.Phone); err != nil {
		h.log.Error().Err(err).Msg("kyc ensure person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	buyer, err := h.store.ResolveBuyer(r.Context(), email)
	if errors.Is(err, ErrBuyerNotFound) {
		writeErr(w, http.StatusNotFound, "person-not-found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("kyc resolve person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Organización: una carpeta por cliente (personID) y otra por tipo de
	// documento → kyc/{personID}/{docType}/{nonce}-{archivo}.
	key := fmt.Sprintf("kyc/%d/%s/%s-%s", buyer.PersonID, req.DocType, hex.EncodeToString(nonce), sanitizeKYCFileName(req.FileName))

	docID, err := h.store.CreateKYCDocument(r.Context(), buyer.PersonID, req.DocType, req.FileName, req.Mime, req.Size, key)
	if err != nil {
		h.log.Error().Err(err).Msg("kyc create document")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	uploadURL, err := h.kyc.PresignPut(r.Context(), key, req.Mime, req.Size)
	if err != nil {
		h.log.Error().Err(err).Msg("kyc presign put")
		writeErr(w, http.StatusBadGateway, "storage-unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"document_id": docID,
		"upload_url":  uploadURL,
		"mime":        req.Mime,
		"expires_in":  int(kycPresignPutTTL.Seconds()),
	})
}

type kycConfirmRequest struct {
	Email      string `json:"email"`
	DocumentID int64  `json:"document_id"`
}

// handleKYCConfirm verifica que el objeto exista en S3 y marca el documento
// in_review (+ mlm.person.kyc_status → in_review si aún no está aprobado).
func (h *Handler) handleKYCConfirm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req kycConfirmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid-json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if h.kyc == nil {
		writeErr(w, http.StatusServiceUnavailable, "kyc-unconfigured")
		return
	}
	buyer, err := h.store.ResolveBuyer(r.Context(), email)
	if err != nil {
		writeErr(w, http.StatusNotFound, "person-not-found")
		return
	}
	key, status, err := h.store.GetKYCDocumentKey(r.Context(), req.DocumentID, buyer.PersonID)
	if errors.Is(err, ErrKYCDocNotFound) {
		writeErr(w, http.StatusNotFound, "document-not-found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("kyc get document")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if status != "pending_upload" {
		writeErr(w, http.StatusConflict, "document-already-confirmed")
		return
	}
	size, err := h.kyc.ObjectSize(r.Context(), key)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "object-not-uploaded")
		return
	}
	if size <= 0 || size > kycMaxSizeBytes {
		writeErr(w, http.StatusBadRequest, "invalid-size")
		return
	}
	if err := h.store.ConfirmKYCDocument(r.Context(), req.DocumentID, buyer.PersonID, size); err != nil {
		h.log.Error().Err(err).Msg("kyc confirm document")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Filtro OCR: TODOS los documentos se validan automáticamente (tipo correcto +
	// legible + datos coinciden ⇒ auto-aprobar; si no, rechazado con motivo para
	// re-subir). Se dispara en segundo plano; el confirm responde con in_review.
	h.maybeStartDocOCR(req.DocumentID, buyer.PersonID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "in_review"})
}

// handleKYCDocuments lista los documentos del miembro (sin URLs de descarga).
func (h *Handler) handleKYCDocuments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	buyer, err := h.store.ResolveBuyer(r.Context(), email)
	if errors.Is(err, ErrBuyerNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"documents": []any{}, "kyc_status": "not_started"})
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("kyc resolve person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	docs, kycStatus, err := h.store.ListKYCDocuments(r.Context(), buyer.PersonID)
	if err != nil {
		h.log.Error().Err(err).Msg("kyc list documents")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": docs, "kyc_status": kycStatus})
}

// ── Store ────────────────────────────────────────────────────────────────────

// KYCDocument es la vista member-safe de mlm.kyc_document (sin storage_key).
type KYCDocument struct {
	ID           int64      `json:"id"`
	DocType      string     `json:"doc_type"`
	OriginalName string     `json:"original_name"`
	MimeType     string     `json:"mime_type"`
	SizeBytes    int64      `json:"size_bytes"`
	Status       string     `json:"status"`
	RejectReason *string    `json:"reject_reason,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	ReviewedAt   *time.Time `json:"reviewed_at,omitempty"`
}

// CreateKYCDocument inserta el registro en pending_upload y devuelve su id.
func (s *Store) CreateKYCDocument(ctx context.Context, personID int64, docType, name, mime string, size int64, key string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO mlm.kyc_document (person_id, doc_type, original_name, mime_type, size_bytes, storage_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`, personID, docType, name, mime, size, key).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create kyc document: %w", err)
	}
	return id, nil
}

// GetKYCDocumentKey devuelve storage_key + status validando pertenencia.
func (s *Store) GetKYCDocumentKey(ctx context.Context, docID, personID int64) (string, string, error) {
	var key, status string
	err := s.db.QueryRow(ctx, `
		SELECT storage_key, status FROM mlm.kyc_document
		 WHERE id = $1 AND person_id = $2
	`, docID, personID).Scan(&key, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrKYCDocNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("get kyc document: %w", err)
	}
	return key, status, nil
}

// ConfirmKYCDocument marca el documento in_review (con el tamaño real de S3) y
// mueve person.kyc_status a in_review salvo que ya esté aprobado. Transaccional.
func (s *Store) ConfirmKYCDocument(ctx context.Context, docID, personID, sizeBytes int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE mlm.kyc_document
		   SET status = 'in_review', size_bytes = $3, updated_at = now()
		 WHERE id = $1 AND person_id = $2 AND status = 'pending_upload'
	`, docID, personID, sizeBytes)
	if err != nil {
		return fmt.Errorf("confirm kyc document: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrKYCDocNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.person
		   SET kyc_status = 'in_review', updated_at = now()
		 WHERE id = $1 AND kyc_status IN ('not_started', 'rejected', 'expired')
	`, personID); err != nil {
		return fmt.Errorf("update person kyc_status: %w", err)
	}
	return tx.Commit(ctx)
}

// ListKYCDocuments devuelve los documentos del miembro + su kyc_status global.
func (s *Store) ListKYCDocuments(ctx context.Context, personID int64) ([]KYCDocument, string, error) {
	var kycStatus string
	if err := s.reader().QueryRow(ctx, `
		SELECT kyc_status::text FROM mlm.person WHERE id = $1
	`, personID).Scan(&kycStatus); err != nil {
		return nil, "", fmt.Errorf("person kyc_status: %w", err)
	}
	rows, err := s.reader().Query(ctx, `
		SELECT id, doc_type, original_name, mime_type, size_bytes, status, reject_reason, created_at, reviewed_at
		  FROM mlm.kyc_document
		 WHERE person_id = $1
		 ORDER BY created_at DESC
		 LIMIT 50
	`, personID)
	if err != nil {
		return nil, "", fmt.Errorf("list kyc documents: %w", err)
	}
	defer rows.Close()

	docs := make([]KYCDocument, 0, 8)
	for rows.Next() {
		var d KYCDocument
		if err := rows.Scan(&d.ID, &d.DocType, &d.OriginalName, &d.MimeType, &d.SizeBytes, &d.Status, &d.RejectReason, &d.CreatedAt, &d.ReviewedAt); err != nil {
			return nil, "", fmt.Errorf("scan kyc document: %w", err)
		}
		docs = append(docs, d)
	}
	return docs, kycStatus, rows.Err()
}
