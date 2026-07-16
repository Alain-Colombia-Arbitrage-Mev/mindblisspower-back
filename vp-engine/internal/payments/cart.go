package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ── Recuperación de carritos abandonados ────────────────────────────────────
// Checkouts que quedaron en 'created' (nunca pagados). El sistema: (1) envía un
// recordatorio por email con un link para reanudar el pago, (2) el link regenera
// una sesión de Stripe para el MISMO intent (las sesiones expiran ~24h), (3) el
// panel muestra los carritos y permite reenviar manualmente.

// ── Token de reanudar pago (HMAC) ───────────────────────────────────────────
// Formato: base64url(intentID) + "." + base64url(HMAC-SHA256(intentID, key)).
// Un link público infalsificable que solo puede iniciar el pago de ESE carrito.
// La clave HMAC es el token de servicio (ya secreto).

func (h *Handler) signResumeToken(intentID string) string {
	mac := hmac.New(sha256.New, []byte(h.serviceToken))
	mac.Write([]byte(intentID))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	id := base64.RawURLEncoding.EncodeToString([]byte(intentID))
	return id + "." + sig
}

func (h *Handler) verifyResumeToken(token string) (string, bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	idb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	intentID := string(idb)
	if !hmac.Equal([]byte(token), []byte(h.signResumeToken(intentID))) {
		return "", false
	}
	return intentID, true
}

// resumeInfo son los datos mínimos para regenerar el checkout de un carrito.
type resumeInfo struct {
	PackageID int
	Email     string
	PersonID  int64
	Status    string
}

// CartResumeInfo carga los datos de un intent para reanudar el pago.
func (s *Store) CartResumeInfo(ctx context.Context, intentID string) (resumeInfo, error) {
	var ri resumeInfo
	err := s.db.QueryRow(ctx, `
		SELECT package_id, user_id, person_id, status
		  FROM payments.purchase_intent
		 WHERE id = $1::uuid
	`, intentID).Scan(&ri.PackageID, &ri.Email, &ri.PersonID, &ri.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return resumeInfo{}, ErrIntentNotFound
	}
	if err != nil {
		return resumeInfo{}, fmt.Errorf("cart resume info: %w", err)
	}
	return ri, nil
}

// ReopenIntent revierte un intent 'expired' a 'created' para reanudar el pago.
func (s *Store) ReopenIntent(ctx context.Context, intentID string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE payments.purchase_intent SET status='created', updated_at=now() WHERE id=$1::uuid AND status='expired'`,
		intentID)
	return err
}

// handleResume: GET /api/payments/resume?t=<token> — regenera la sesión de
// Stripe de un carrito abandonado y devuelve {url}. Lo llama el BFF de
// growth-hub (token de servicio) desde el link público del correo.
func (h *Handler) handleResume(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	intentID, ok := h.verifyResumeToken(strings.TrimSpace(r.URL.Query().Get("t")))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	ctx := r.Context()
	ri, err := h.store.CartResumeInfo(ctx, intentID)
	if errors.Is(err, ErrIntentNotFound) {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("intent", intentID).Msg("resume: load")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	switch ri.Status {
	case "paid", "activated":
		writeJSON(w, http.StatusOK, map[string]any{"status": "already_paid", "url": h.successURL})
		return
	case "created", "expired", "needs_placement":
		// resumible
	default:
		writeErr(w, http.StatusConflict, "not_resumable")
		return
	}
	pack, err := h.store.LookupPack(ctx, ri.PackageID)
	if err != nil {
		h.log.Error().Err(err).Msg("resume: lookup pack")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	meta := map[string]string{
		"purchase_intent_id": intentID,
		"email":              ri.Email,
		"person_id":          strconv.FormatInt(ri.PersonID, 10),
		"package_id":         strconv.Itoa(pack.ID),
		"pv":                 strconv.Itoa(pack.PV),
	}
	url, sessionID, err := h.gw.CreateCheckout(pack, intentID, meta)
	if err != nil {
		h.log.Error().Err(err).Str("intent", intentID).Msg("resume: stripe checkout")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	if ri.Status == "expired" {
		_ = h.store.ReopenIntent(ctx, intentID)
	}
	if err := h.store.AttachSession(ctx, intentID, sessionID); err != nil {
		h.log.Error().Err(err).Msg("resume: attach session")
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "url": url})
}

// ── Recordatorios ───────────────────────────────────────────────────────────

type abandonedCart struct {
	IntentID string
	Email    string
	Name     string
	Plan     string
	Amount   string
}

// AbandonedCartsForReminder lista carritos 'created' elegibles para recordatorio:
// creados tras `cutoff`, con 1h–7d de antigüedad, menos de maxCount recordatorios,
// último recordatorio hace >24h, y comprador NO suspendido/baneado.
func (s *Store) AbandonedCartsForReminder(ctx context.Context, cutoff time.Time, maxCount, limit int) ([]abandonedCart, error) {
	rows, err := s.db.Query(ctx, `
		SELECT pi.id::text, pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id = pi.person_id), ''),
		       pk.name, pi.amount_usd::text
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.status = 'created'
		   AND pi.created_at >= $1
		   AND pi.created_at <= now() - interval '1 hour'
		   AND pi.created_at >= now() - interval '7 days'
		   AND pi.reminder_count < $2
		   AND (pi.reminder_sent_at IS NULL OR pi.reminder_sent_at <= now() - interval '24 hours')
		   AND NOT EXISTS (SELECT 1 FROM mlm.person p WHERE p.id = pi.person_id AND (p.blacklisted OR p.status = 'suspended'))
		 ORDER BY pi.created_at
		 LIMIT $3
	`, cutoff, maxCount, limit)
	if err != nil {
		return nil, fmt.Errorf("abandoned carts: %w", err)
	}
	defer rows.Close()
	out := []abandonedCart{}
	for rows.Next() {
		var c abandonedCart
		if err := rows.Scan(&c.IntentID, &c.Email, &c.Name, &c.Plan, &c.Amount); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkReminderSent incrementa el contador de recordatorios.
func (s *Store) MarkReminderSent(ctx context.Context, intentID string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE payments.purchase_intent SET reminder_count = reminder_count + 1, reminder_sent_at = now(), updated_at = now() WHERE id = $1::uuid`,
		intentID)
	return err
}

// LoadCartForReminder carga un carrito puntual (para el reenvío manual del admin).
func (s *Store) LoadCartForReminder(ctx context.Context, intentID string) (abandonedCart, string, error) {
	var c abandonedCart
	var status string
	err := s.db.QueryRow(ctx, `
		SELECT pi.id::text, pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id = pi.person_id), ''),
		       pk.name, pi.amount_usd::text, pi.status
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.id = $1::uuid
	`, intentID).Scan(&c.IntentID, &c.Email, &c.Name, &c.Plan, &c.Amount, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return abandonedCart{}, "", ErrIntentNotFound
	}
	if err != nil {
		return abandonedCart{}, "", fmt.Errorf("load cart: %w", err)
	}
	return c, status, nil
}

// sendCartReminder envía UN correo de recordatorio con link de reanudar pago.
func (h *Handler) sendCartReminder(ctx context.Context, c abandonedCart) error {
	link := strings.TrimRight(h.resumeBaseURL, "/") + "/api/pay/resume?t=" + h.signResumeToken(c.IntentID)
	greeting := "Hola"
	if c.Name != "" {
		greeting = "Hola " + c.Name
	}
	subject := "Tu compra en MindBliss Power quedó pendiente"
	body := fmt.Sprintf(`%s,

Notamos que empezaste tu compra pero no la completaste.

  Membresía: %s
  Monto:     $%s USD

Puedes completar tu pago de forma segura aquí:
%s

Si ya realizaste el pago, ignora este mensaje.

— Equipo MindBliss Power`, greeting, c.Plan, c.Amount, link)
	return h.store.SendEmail(ctx, []string{c.Email}, subject, body)
}

// RemindAbandonedCarts corre el sweep de recordatorios (best-effort). Devuelve
// cuántos recordatorios se enviaron. cutoff limita a carritos nuevos.
func (h *Handler) RemindAbandonedCarts(ctx context.Context, cutoff time.Time, maxCount int) (int, error) {
	carts, err := h.store.AbandonedCartsForReminder(ctx, cutoff, maxCount, 200)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, c := range carts {
		if err := h.sendCartReminder(ctx, c); err != nil {
			h.log.Error().Err(err).Str("intent", c.IntentID).Str("to", c.Email).Msg("recordatorio: envío falló")
			continue
		}
		if err := h.store.MarkReminderSent(ctx, c.IntentID); err != nil {
			h.log.Error().Err(err).Str("intent", c.IntentID).Msg("recordatorio: marcar")
		}
		sent++
	}
	if sent > 0 {
		h.log.Info().Int("sent", sent).Int("candidates", len(carts)).Msg("recordatorios de carrito enviados")
	}
	return sent, nil
}

// handleAdminCartRemind: POST /api/admin/carts/remind {id} — reenvía un
// recordatorio manualmente (ignora cutoff/ventana; respeta 'ya pagado').
func (h *Handler) handleAdminCartRemind(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req); err != nil || strings.TrimSpace(req.ID) == "" {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	ctx := r.Context()
	c, status, err := h.store.LoadCartForReminder(ctx, req.ID)
	if errors.Is(err, ErrIntentNotFound) {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("cart remind: load")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if status == "paid" || status == "activated" {
		writeErr(w, http.StatusConflict, "already_paid")
		return
	}
	if err := h.sendCartReminder(ctx, c); err != nil {
		h.log.Error().Err(err).Str("intent", c.IntentID).Msg("cart remind: send")
		writeErr(w, http.StatusBadGateway, "email_error")
		return
	}
	if err := h.store.MarkReminderSent(ctx, c.IntentID); err != nil {
		h.log.Error().Err(err).Msg("cart remind: mark")
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "to": c.Email})
}

// CartsSummary son las métricas de carritos abandonados del período.
type CartsSummary struct {
	AbandonedCount int64  `json:"abandoned_count"`
	AbandonedUSD   string `json:"abandoned_usd"`
	RecoveredCount int64  `json:"recovered_count"`
}

func (s *Store) CartsSummary(ctx context.Context, from time.Time) (CartsSummary, error) {
	var cs CartsSummary
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status='created'),
		       COALESCE(sum(amount_usd) FILTER (WHERE status='created'),0)::text,
		       count(*) FILTER (WHERE reminder_count>0 AND status IN ('paid','activated'))
		  FROM payments.purchase_intent
		 WHERE created_at >= $1
	`, from).Scan(&cs.AbandonedCount, &cs.AbandonedUSD, &cs.RecoveredCount); err != nil {
		return CartsSummary{}, fmt.Errorf("carts summary: %w", err)
	}
	return cs, nil
}

// handleAdminCartsSummary: GET /api/admin/carts/summary?days=30
func (h *Handler) handleAdminCartsSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	from := time.Now().UTC().AddDate(0, 0, -days)
	cs, err := h.store.CartsSummary(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("carts summary")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": cs, "days": days})
}
