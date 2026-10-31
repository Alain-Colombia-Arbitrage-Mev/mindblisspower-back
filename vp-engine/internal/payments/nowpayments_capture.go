package payments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

var errNOWCaptureOrderNotFound = errors.New("owned NOWPayments order not found")

// No invoice creation method is available to this isolated flow.
type nowCaptureClient interface {
	GetPayment(context.Context, string) (nowpayments.Payment, error)
	VerifyIPN([]byte, string) (nowpayments.Payment, error)
}

type nowCapturePersistence interface {
	Capture(context.Context, string, nowpayments.Payment, nowpayments.Payment, string) error
	OwnedStatus(context.Context, string, string, string, string) (NOWPaymentsCaptureStatus, error)
}

type nowPaymentsCapture struct {
	client      nowCaptureClient
	store       nowCapturePersistence
	environment string
}

type NOWPaymentsCaptureStore struct{ db *pgxpool.Pool }

func NewNOWPaymentsCaptureStore(db *pgxpool.Pool) *NOWPaymentsCaptureStore {
	return &NOWPaymentsCaptureStore{db: db}
}

func (h *Handler) SetNOWPaymentsCapture(client *nowpayments.Client, store *NOWPaymentsCaptureStore, environment string) error {
	if client == nil || store == nil || store.db == nil || client.Environment() != environment || !validNOWPaymentsEnvironment(environment) {
		return nowpayments.ErrConfiguration
	}
	h.nowCapture = &nowPaymentsCapture{client: client, store: store, environment: environment}
	return nil
}

// The projection is deliberately not a membership, balance or settlement API.
type NOWPaymentsCaptureStatus struct {
	Provider           string `json:"provider"`
	OrderID            string `json:"order_id"`
	State              string `json:"state"`
	PaymentConfirmed   bool   `json:"payment_confirmed"`
	SignatureValidated bool   `json:"signature_validated"`
	ProviderVerified   bool   `json:"provider_verified"`
	Persisted          bool   `json:"persisted"`
	FulfillmentStatus  string `json:"fulfillment_status"`
}

func pendingNOWCaptureStatus(order string) NOWPaymentsCaptureStatus {
	return NOWPaymentsCaptureStatus{Provider: "nowpayments", OrderID: order, State: "pending", FulfillmentStatus: "not_activated"}
}

func captureEvidenceMatches(signed, api nowpayments.Payment) bool {
	if !nowPaymentsIDPattern.MatchString(string(signed.PaymentID)) || signed.PaymentID != api.PaymentID ||
		signed.InvoiceID != api.InvoiceID || signed.OrderID != api.OrderID || len(api.OrderID) > 128 ||
		signed.PriceCurrency != api.PriceCurrency || signed.PayCurrency != api.PayCurrency ||
		len(api.Status) == 0 || len(api.Status) > 64 || len(signed.Status) == 0 || len(signed.Status) > 64 {
		return false
	}
	// Status/actually_paid can legitimately advance between the IPN and GET.
	// Corroborate immutable invoice price, never a float approximation.
	a, errA := decimal.NewFromString(string(signed.PriceAmount))
	b, errB := decimal.NewFromString(string(api.PriceAmount))
	return errA == nil && errB == nil && a.Sign() > 0 && a.Equal(b)
}

func (h *Handler) handleNOWPaymentsCapture(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeErr(w, http.StatusBadRequest, "invalid_payment_query")
		return
	}
	flow := h.nowCapture
	if flow == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, "json_required")
		return
	}
	sig := r.Header.Get("x-nowpayments-sig")
	if len(sig) != 128 {
		writeErr(w, http.StatusUnauthorized, "invalid_payment_signature")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return
	}
	signed, err := flow.client.VerifyIPN(body, sig)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_payment_signature")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2500*time.Millisecond)
	defer cancel()
	api, err := flow.client.GetPayment(ctx, string(signed.PaymentID))
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "payment_verification_unavailable")
		return
	}
	if !captureEvidenceMatches(signed, api) {
		writeErr(w, http.StatusConflict, "payment_evidence_mismatch")
		return
	}
	hash := sha256.Sum256(body)
	if err := flow.store.Capture(ctx, flow.environment, signed, api, hex.EncodeToString(hash[:])); err != nil {
		// No provider payload, token, customer detail or database error is logged.
		writeErr(w, http.StatusServiceUnavailable, "payment_capture_unavailable")
		return
	}
	if h.nowMemberships != nil && h.nowMemberships.operational {
		store, ok := h.nowMemberships.store.(*Store)
		if !ok {
			writeErr(w, http.StatusServiceUnavailable, "membership_activation_unavailable")
			return
		}
		_, err := store.enqueueNOWOperationalPayment(ctx, flow.environment, signed.OrderID, string(signed.PaymentID), hex.EncodeToString(hash[:]))
		if err != nil {
			writeErr(w, http.StatusServiceUnavailable, "membership_activation_unavailable")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true, "mode": "capture_only", "state": "captured", "fulfillment_status": "not_activated"})
}

type nowSubjectVerifier interface {
	VerifySubject(context.Context, string) (string, string, error)
}

func (h *Handler) handleNOWPaymentsCaptureStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	flow := h.nowCapture
	if flow == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	order := query.Get("order_id")
	if err != nil || r.URL.RawPath != "" || len(query) != 1 || len(query["order_id"]) != 1 || !validNOWPaymentsOrderID(order) || r.Header.Get(actAsHeader) != "" {
		writeErr(w, http.StatusBadRequest, "invalid_payment_query")
		return
	}
	verifier, ok := h.verifier.(nowSubjectVerifier)
	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if !ok || raw == "" {
		writeErr(w, http.StatusUnauthorized, "id_token_required")
		return
	}
	subject, email, err := verifier.VerifySubject(r.Context(), raw)
	if err != nil || subject == "" || email == "" {
		writeErr(w, http.StatusUnauthorized, "invalid_id_token")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	status, err := flow.store.OwnedStatus(ctx, flow.environment, order, subject, email)
	if err == nil && h.nowMemberships != nil && h.nowMemberships.operational {
		if store, ok := h.nowMemberships.store.(*Store); ok {
			if state, opErr := store.ownedNOWOperationalState(ctx, flow.environment, order, subject, email); opErr != nil {
				err = opErr
			} else if state != "" {
				status.FulfillmentStatus = state
				if state == "activated" && status.PaymentConfirmed {
					status.State = "completed"
				}
				if state == "risk_review" || state == "security_blocked" {
					status.PaymentConfirmed = false
					status.State = "under_review"
				}
			}
		}
	}
	if errors.Is(err, errNOWCaptureOrderNotFound) {
		writeErr(w, http.StatusNotFound, "payment_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "payment_status_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// Capture only inserts into the evidence table using its dedicated login. No
// operational guard is relaxed; Stripe, orders, MLM and ledger are untouched.
func (s *NOWPaymentsCaptureStore) Capture(ctx context.Context, environment string, signed, api nowpayments.Payment, bodyHash string) error {
	if !validNOWPaymentsEnvironment(environment) || !captureEvidenceMatches(signed, api) || !nowPaymentsSHA256Pattern.MatchString(bodyHash) {
		return nowpayments.ErrEvidence
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin capture: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='2s'`); err != nil {
		return err
	}
	// Serialize the first association per provider payment. Unknown payments
	// remain quarantined forever; later retries cannot claim a newly made order.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('nowpayments_capture:'||$1||':'||$2,0))`, environment, string(api.PaymentID)); err != nil {
		return err
	}
	var priorMatch *string
	var priorOrder, priorInvoice string
	err = tx.QueryRow(ctx, `SELECT matched_attempt_id::text,order_id,COALESCE(invoice_id,'')
 FROM payments.nowpayments_webhook_capture WHERE environment=$1 AND payment_id=$2 ORDER BY id LIMIT 1`, environment, string(api.PaymentID)).Scan(&priorMatch, &priorOrder, &priorInvoice)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	firstObservation := errors.Is(err, pgx.ErrNoRows)
	mayAssociate := firstObservation || (priorMatch != nil && priorOrder == api.OrderID && priorInvoice == string(api.InvoiceID))
	var ordersExist bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('payments.nowpayments_membership_attempt') IS NOT NULL`).Scan(&ordersExist); err != nil {
		return err
	}
	var matched *string
	finished := false
	signedFinishedInvalid := false
	if mayAssociate && ordersExist && validNOWPaymentsOrderID(api.OrderID) {
		var id, invoice, currency string
		var total int64
		err := tx.QueryRow(ctx, `SELECT id::text,COALESCE(invoice_id,''),currency,total_cents
 FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid AND environment=$2 AND state<>'closed_reviewed'`, api.OrderID, environment).
			Scan(&id, &invoice, &currency, &total)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && invoice != "" && invoice == string(api.InvoiceID) && currency == "usd" {
			price, pErr := decimal.NewFromString(string(api.PriceAmount))
			if pErr == nil && price.Equal(decimal.NewFromInt(total).Div(decimal.NewFromInt(100))) {
				matched = &id
				expected := nowpayments.ExpectedPayment{OrderID: id, InvoiceID: invoice, PaymentID: string(api.PaymentID), AmountUSDMinor: total}
				finished = nowpayments.ValidateFinished(api, expected) == nil
				signedFinishedInvalid = signed.Status == "finished" && nowpayments.ValidateFinished(signed, expected) != nil
			}
		}
	}
	disposition := "quarantined"
	if matched != nil {
		disposition = "matched"
	}
	risk := !ordinaryNOWCaptureState(api.Status) || !ordinaryNOWCaptureState(signed.Status) || signedFinishedInvalid ||
		(matched != nil && api.Status == "finished" && !finished) || (!firstObservation && priorMatch != nil && matched == nil)
	signedJSON, err := json.Marshal(signed)
	if err != nil {
		return err
	}
	apiJSON, err := json.Marshal(api)
	if err != nil {
		return err
	}
	apiHash := sha256.Sum256(apiJSON)
	_, err = tx.Exec(ctx, `INSERT INTO payments.nowpayments_webhook_capture
 (environment,payment_id,invoice_id,order_id,matched_attempt_id,payment_status,finished_verified,risk_detected,disposition,
  body_sha256,api_sha256,signed_evidence,api_evidence)
 VALUES($1,$2,NULLIF($3,''),$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
 ON CONFLICT(environment,payment_id,body_sha256,api_sha256) DO NOTHING`, environment, string(api.PaymentID), string(api.InvoiceID), api.OrderID,
		matched, api.Status, finished, risk, disposition, bodyHash, hex.EncodeToString(apiHash[:]), signedJSON, apiJSON)
	if err != nil {
		return fmt.Errorf("persist capture: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *NOWPaymentsCaptureStore) OwnedStatus(ctx context.Context, environment, order, subject, email string) (NOWPaymentsCaptureStatus, error) {
	status := pendingNOWCaptureStatus(order)
	if !validNOWPaymentsEnvironment(environment) || !validNOWPaymentsOrderID(order) || subject == "" || email == "" {
		return status, errNOWCaptureOrderNotFound
	}
	// Ownership is the signed subject PLUS current verified binding, never a
	// query email, success URL, external invoice ID or claimed payment metadata.
	var owned string
	err := s.db.QueryRow(ctx, `SELECT o.id::text FROM payments.nowpayments_membership_attempt o
 JOIN identity.auth_binding b ON b.provider='better_auth' AND b.subject=o.auth_subject AND b.person_id=o.person_id
 JOIN auth.user u ON u.id=b.subject JOIN mlm.person p ON p.id=b.person_id
 WHERE o.id=$1::uuid AND o.environment=$2 AND o.auth_subject=$3 AND p.user_id=$3
 AND p.public_id=o.person_public_id AND u.email_verified=true
 AND lower(btrim(u.email))=lower(btrim(p.email::text)) AND lower(btrim(u.email))=$4
 AND p.status::text IN ('pending','active') AND NOT COALESCE(p.blacklisted,false)`, order, environment, subject, strings.ToLower(strings.TrimSpace(email))).Scan(&owned)
	if errors.Is(err, pgx.ErrNoRows) {
		return status, errNOWCaptureOrderNotFound
	}
	if err != nil {
		return status, err
	}
	var providerState string
	var finished, historicalRisk bool
	var payments int
	err = s.db.QueryRow(ctx, `SELECT e.payment_status,e.finished_verified,
 (SELECT count(DISTINCT c.payment_id)::int FROM payments.nowpayments_webhook_capture c
 WHERE c.environment=$1 AND c.matched_attempt_id=$2::uuid),
 EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture r
 WHERE r.environment=$1 AND r.risk_detected AND r.payment_id IN (
 SELECT a.payment_id FROM payments.nowpayments_webhook_capture a WHERE a.environment=$1 AND a.matched_attempt_id=$2::uuid))
 FROM payments.nowpayments_webhook_capture e
 WHERE e.environment=$1 AND e.matched_attempt_id=$2::uuid ORDER BY e.id DESC LIMIT 1`, environment, owned).
		Scan(&providerState, &finished, &payments, &historicalRisk)
	if errors.Is(err, pgx.ErrNoRows) {
		return status, nil
	}
	if err != nil {
		return status, err
	}
	status.Persisted, status.SignatureValidated, status.ProviderVerified = true, true, true
	if payments != 1 || historicalRisk {
		status.State = "under_review"
		return status, nil
	}
	if providerState == "finished" && finished {
		status.State, status.PaymentConfirmed = "completed", true
		return status, nil
	}
	switch providerState {
	case "waiting", "confirming", "confirmed", "sending":
	default:
		status.State = "under_review"
	}
	return status, nil
}

func ordinaryNOWCaptureState(state string) bool {
	switch state {
	case "waiting", "confirming", "confirmed", "sending", "finished":
		return true
	}
	return false
}
