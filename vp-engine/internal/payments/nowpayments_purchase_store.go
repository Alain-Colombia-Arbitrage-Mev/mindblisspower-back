package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrNOWPurchaseRequestInvalid  = errors.New("invalid NOW purchase request")
	ErrNOWPurchaseRequestConflict = errors.New("NOW purchase request belongs to another package")
	ErrNOWPurchaseProcessed       = errors.New("NOW purchase request already processed")
	ErrNOWPurchaseCannotResume    = errors.New("NOW purchase cannot be resumed")
	ErrNOWPurchaseCannotCancel    = errors.New("NOW purchase cannot be abandoned")
)

type NOWPurchaseHistory struct {
	Provider  string            `json:"provider"`
	Purpose   string            `json:"purpose"`
	Purchases []NOWPurchaseItem `json:"purchases"`
	HasMore   bool              `json:"has_more"`
}

type NOWPurchaseItem struct {
	OrderID           string  `json:"order_id"`
	PackageID         int     `json:"package_id"`
	PackageName       string  `json:"package_name"`
	TotalUSD          string  `json:"total_usd"`
	FeeUSD            string  `json:"fee_usd"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
	PaymentStatus     string  `json:"payment_status"`
	FulfillmentStatus string  `json:"fulfillment_status"`
	CanResume         bool    `json:"can_resume"`
	CanCancel         bool    `json:"can_cancel"`
	CancelledAt       *string `json:"cancelled_at"`
}

type NOWPurchaseCancellationResult struct {
	OrderID                string `json:"order_id"`
	State                  string `json:"state"`
	ProviderInvoiceRevoked bool   `json:"provider_invoice_revoked"`
	LatePaymentPolicy      string `json:"late_payment_policy"`
}

type nowPurchaseSnapshot struct {
	NOWPurchaseItem
	attemptState, operationalState, invoiceID, paymentID, latestStatus string
	open, evidence, risk, finished                                     bool
}

// A verified subject selects the owner. Email never selects a different legacy
// identity; ambiguous bindings, unverified accounts and impersonation fail shut.
func nowPurchaseOwner(ctx context.Context, tx pgx.Tx, subject, email string) (int64, string, error) {
	var person int64
	var publicID string
	if subject == "" || len(subject) > 512 || email == "" || len(email) > 320 {
		return 0, "", ErrCheckoutIdentityReview
	}
	err := tx.QueryRow(ctx, `SELECT p.id,p.public_id::text FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject
 JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
 WHERE b.subject=$1 AND b.provider='better_auth' AND u.email_verified AND lower(btrim(u.email))=$2 AND lower(btrim(p.email::text))=$2
 AND p.status::text IN('active','pending') AND NOT COALESCE(p.blacklisted,false)
 AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND lower(btrim(other.email::text))=$2)`, subject, strings.ToLower(strings.TrimSpace(email))).Scan(&person, &publicID)
	if err != nil {
		return 0, "", ErrCheckoutIdentityReview
	}
	return person, publicID, nil
}

func nowPurchaseCollectionAllowed(ctx context.Context, tx pgx.Tx, person int64, email string) (bool, error) {
	decision, err := banDecisionFor(ctx, tx, BanCandidate{Email: email})
	if err != nil || decision.Blocked {
		return false, err
	}
	var allowed bool
	err = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM mlm.affiliate WHERE person_id=$1 AND status::text<>'active')`, person).Scan(&allowed)
	return allowed, err
}

const nowPurchaseSnapshotSQL = `SELECT a.id::text,a.package_id,a.package_name,a.total_cents,a.fee_usd::text,a.created_at,a.updated_at,
 a.state,COALESCE(o.state,''),COALESCE(a.invoice_id,''),COALESCE(a.payment_id,''),a.checkout_open,c.cancelled_at,
 (EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=a.id)
 OR EXISTS(SELECT 1 FROM payments.nowpayments_payment_binding b WHERE b.attempt_id=a.id)
 OR EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture e WHERE e.environment=a.environment AND(e.matched_attempt_id=a.id OR e.order_id=a.id::text))),
 (EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=a.id AND(r.multiple_payments OR COALESCE(r.api_evidence->>'payment_status','') NOT IN('waiting','confirming','confirmed','sending','finished')))
 OR EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture e WHERE e.environment=a.environment AND(e.matched_attempt_id=a.id OR e.order_id=a.id::text) AND(e.risk_detected OR e.disposition='quarantined'))),
 EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture e WHERE e.environment=a.environment AND e.matched_attempt_id=a.id AND e.finished_verified AND NOT e.risk_detected AND e.disposition='matched'),
 COALESCE((SELECT e.api_evidence->>'payment_status' FROM payments.nowpayments_webhook_capture e WHERE e.environment=a.environment AND e.matched_attempt_id=a.id ORDER BY e.id DESC LIMIT 1),'')
 FROM payments.nowpayments_membership_attempt a LEFT JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id
 LEFT JOIN payments.nowpayments_purchase_cancellation c ON c.attempt_id=a.id
 WHERE a.environment=$1 AND a.auth_subject=$2 AND a.person_id=$3 AND a.person_public_id=$4::uuid`

func scanNOWPurchase(row pgx.Row) (nowPurchaseSnapshot, error) {
	var out nowPurchaseSnapshot
	var total int64
	var created, updated time.Time
	var cancelled *time.Time
	err := row.Scan(&out.OrderID, &out.PackageID, &out.PackageName, &total, &out.FeeUSD, &created, &updated,
		&out.attemptState, &out.operationalState, &out.invoiceID, &out.paymentID, &out.open, &cancelled,
		&out.evidence, &out.risk, &out.finished, &out.latestStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNOWPaymentsAttemptNotFound
	}
	if err != nil {
		return out, err
	}
	out.TotalUSD, err = nowPaymentsTotalUSD(total)
	if err != nil {
		return out, err
	}
	out.CreatedAt, out.UpdatedAt = created.UTC().Format(time.RFC3339Nano), updated.UTC().Format(time.RFC3339Nano)
	if cancelled != nil {
		stamp := cancelled.UTC().Format(time.RFC3339Nano)
		out.CancelledAt = &stamp
	}
	out.project()
	return out, nil
}

func (s *nowPurchaseSnapshot) project() {
	s.PaymentStatus, s.FulfillmentStatus = "under_review", "not_activated"
	s.CanResume, s.CanCancel = false, false
	if s.CancelledAt != nil {
		if !s.evidence && s.paymentID == "" {
			s.PaymentStatus = "cancelled_local"
		}
		return
	}
	if s.risk || s.operationalState == "risk_review" || s.operationalState == "security_blocked" {
		return
	}
	if s.operationalState == "activated" && s.finished {
		s.PaymentStatus, s.FulfillmentStatus = "completed", "activated"
		return
	}
	if s.operationalState != "awaiting_payment" {
		return
	}
	s.FulfillmentStatus = "awaiting_payment"
	if s.attemptState == "creating_invoice" || s.attemptState == "invoice_unknown" {
		s.PaymentStatus = "invoice_unknown"
		return
	}
	if s.finished {
		s.PaymentStatus = "completed"
		return
	}
	if s.evidence || s.paymentID != "" {
		if s.latestStatus == "waiting" || s.latestStatus == "confirming" || s.latestStatus == "confirmed" || s.latestStatus == "sending" {
			s.PaymentStatus = "processing"
		}
		return
	}
	if s.open && s.attemptState == "invoice_created" && nowPaymentsIDPattern.MatchString(s.invoiceID) {
		s.PaymentStatus, s.CanResume, s.CanCancel = "awaiting_payment", true, true
	}
}

func nowPaymentsTotalUSD(cents int64) (string, error) {
	if cents <= 0 {
		return "", ErrNOWPaymentsEvidence
	}
	return fmt.Sprintf("%d.%02d", cents/100, cents%100), nil
}

func nowPurchaseInvoiceURL(environment, invoiceID string) (string, error) {
	if !validNOWPaymentsEnvironment(environment) || !nowPaymentsIDPattern.MatchString(invoiceID) {
		return "", ErrNOWPaymentsEvidence
	}
	host := "nowpayments.io"
	if environment == "sandbox" {
		host = "sandbox.nowpayments.io"
	}
	return "https://" + host + "/payment/?iid=" + invoiceID, nil
}

// Only the exact owner/environment/request key identifies a retry. A different
// explicit request may buy the same SKU independently, including while pending.
func bindNOWPurchaseRequest(ctx context.Context, tx pgx.Tx, in NOWPaymentsMembershipInput, attemptID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_purchase_request(auth_subject,environment,purchase_request_id,attempt_id)
 VALUES($1,$2,$3::uuid,$4::uuid)`, in.Subject, in.Environment, in.PurchaseRequestID, attemptID)
	return err
}

func lookupNOWPurchaseRequest(ctx context.Context, tx pgx.Tx, in NOWPaymentsMembershipInput, person int64, publicID string) (NOWPaymentsMembershipAttempt, bool, error) {
	var attemptID string
	err := tx.QueryRow(ctx, `SELECT attempt_id::text FROM payments.nowpayments_purchase_request
 WHERE auth_subject=$1 AND environment=$2 AND purchase_request_id=$3::uuid`, in.Subject, in.Environment, in.PurchaseRequestID).Scan(&attemptID)
	if errors.Is(err, pgx.ErrNoRows) {
		return NOWPaymentsMembershipAttempt{}, false, nil
	}
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, false, err
	}
	attempt, err := scanNOWPaymentsAttempt(tx.QueryRow(ctx, `SELECT `+nowPaymentsAttemptColumns+` FROM payments.nowpayments_membership_attempt
 WHERE id=$1::uuid AND auth_subject=$2 AND environment=$3 AND person_id=$4 AND person_public_id=$5::uuid`, attemptID, in.Subject, in.Environment, person, publicID))
	if err != nil {
		return attempt, true, err
	}
	if attempt.PackageID != in.PackageID {
		return attempt, true, ErrNOWPurchaseRequestConflict
	}
	snapshot, err := scanNOWPurchase(tx.QueryRow(ctx, nowPurchaseSnapshotSQL+` AND a.id=$5::uuid`, in.Environment, in.Subject, person, publicID, attemptID))
	if err != nil {
		return attempt, true, err
	}
	if snapshot.operationalState == "activated" || snapshot.CancelledAt != nil || !snapshot.open {
		return attempt, true, ErrNOWPurchaseProcessed
	}
	attempt.Reused, attempt.Reusable = true, snapshot.CanResume
	return attempt, true, nil
}

// ValidateNOWPurchasePolicy proves that the reviewed independent-intent schema
// is installed. Catalog reads need no new runtime grants. This gate belongs to
// new checkout/readiness only, never to capture or already-issued payment jobs.
func (s *Store) ValidateNOWPurchasePolicy(ctx context.Context, tx pgx.Tx) error {
	if !s.nowOperational {
		return ErrNOWOperationalPlan
	}
	var ready bool
	err := tx.QueryRow(ctx, `SELECT to_regclass('payments.nowpayments_membership_outstanding_unique') IS NULL
 AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('payments.nowpayments_membership_open_lookup_idx')
 AND i.indrelid=to_regclass('payments.nowpayments_membership_attempt') AND i.indisvalid AND i.indisready
 AND NOT i.indisunique AND i.indexprs IS NULL AND i.indnkeyatts=3 AND i.indnatts=3
 AND pg_get_expr(i.indpred,i.indrelid)='((state <> ''closed_reviewed''::text) AND checkout_open)'
 AND pg_get_indexdef(i.indexrelid,1,true)='person_id' AND pg_get_indexdef(i.indexrelid,2,true)='package_id'
 AND pg_get_indexdef(i.indexrelid,3,true)='environment')
 AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('payments.nowpayments_purchase_request')
 AND c.contype='p' AND c.convalidated AND c.conkey=ARRAY[1,2,3]::smallint[]
 AND pg_get_constraintdef(c.oid)='PRIMARY KEY (auth_subject, environment, purchase_request_id)'
 AND EXISTS(SELECT 1 FROM pg_index p WHERE p.indexrelid=c.conindid AND p.indisunique AND p.indisvalid AND p.indisready))`).Scan(&ready)
	if err != nil || !ready {
		return ErrNOWOperationalPlan
	}
	return nil
}

func (s *Store) ListNOWPurchases(ctx context.Context, environment, subject, email string) (NOWPurchaseHistory, error) {
	out := NOWPurchaseHistory{Provider: "nowpayments", Purpose: "membership", Purchases: []NOWPurchaseItem{}}
	if !validNOWPaymentsEnvironment(environment) {
		return out, ErrNOWPaymentsEvidence
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	person, publicID, err := nowPurchaseOwner(ctx, tx, subject, email)
	if err != nil {
		return out, err
	}
	allowed, err := nowPurchaseCollectionAllowed(ctx, tx, person, email)
	if err != nil {
		return out, err
	}
	rows, err := tx.Query(ctx, nowPurchaseSnapshotSQL+` ORDER BY a.created_at DESC,a.id DESC LIMIT 101`, environment, subject, person, publicID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		item, err := scanNOWPurchase(rows)
		if err != nil {
			rows.Close()
			return out, err
		}
		if len(out.Purchases) == 100 {
			out.HasMore = true
			break
		}
		if !allowed && item.CanResume {
			item.CanResume, item.PaymentStatus = false, "under_review"
		}
		out.Purchases = append(out.Purchases, item.NOWPurchaseItem)
	}
	rows.Close()
	if rows.Err() != nil {
		return out, rows.Err()
	}
	return out, tx.Commit(ctx)
}

func (s *Store) ResumeNOWPurchase(ctx context.Context, environment, subject, email, orderID string) (NOWPaymentsMembershipAttempt, error) {
	if !validNOWPaymentsEnvironment(environment) || !validNOWPaymentsOrderID(orderID) {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsEvidence
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	defer tx.Rollback(ctx)
	person, publicID, err := nowPurchaseOwner(ctx, tx, subject, email)
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	allowed, err := nowPurchaseCollectionAllowed(ctx, tx, person, email)
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	if !allowed {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPurchaseCannotResume
	}
	snapshot, err := scanNOWPurchase(tx.QueryRow(ctx, nowPurchaseSnapshotSQL+` AND a.id=$5::uuid`, environment, subject, person, publicID, orderID))
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	if !snapshot.CanResume {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPurchaseCannotResume
	}
	attempt, err := scanNOWPaymentsAttempt(tx.QueryRow(ctx, `SELECT `+nowPaymentsAttemptColumns+` FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid`, orderID))
	if err != nil {
		return attempt, err
	}
	attempt.Reused, attempt.Reusable = true, true
	return attempt, tx.Commit(ctx)
}

func (s *Store) CancelNOWPurchase(ctx context.Context, environment, subject, email, orderID string) (NOWPurchaseCancellationResult, error) {
	out := NOWPurchaseCancellationResult{OrderID: orderID, State: "cancelled_local", LatePaymentPolicy: "review_required"}
	if !s.nowOperational || !validNOWPaymentsEnvironment(environment) || !validNOWPaymentsOrderID(orderID) {
		return out, ErrNOWPaymentsEvidence
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	person, publicID, err := nowPurchaseOwner(ctx, tx, subject, email)
	if err != nil {
		return out, err
	}
	// Same order as activation: attempt first, then operational row. Do not lock
	// person here (activation locks person only after these two rows).
	var locked string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid AND environment=$2 AND auth_subject=$3 AND person_id=$4 AND person_public_id=$5::uuid FOR UPDATE`, orderID, environment, subject, person, publicID).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNOWPaymentsAttemptNotFound
		}
		return out, err
	}
	if err := tx.QueryRow(ctx, `SELECT attempt_id::text FROM payments.nowpayments_operational_order WHERE attempt_id=$1::uuid FOR UPDATE`, orderID).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNOWPurchaseCannotCancel
		}
		return out, err
	}
	snapshot, err := scanNOWPurchase(tx.QueryRow(ctx, nowPurchaseSnapshotSQL+` AND a.id=$5::uuid`, environment, subject, person, publicID, orderID))
	if err != nil {
		return out, err
	}
	if snapshot.CancelledAt != nil {
		return out, tx.Commit(ctx)
	}
	if !snapshot.CanCancel {
		return out, ErrNOWPurchaseCannotCancel
	}
	if _, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_purchase_cancellation(attempt_id,auth_subject,environment) VALUES($1::uuid,$2,$3)`, orderID, subject, environment); err != nil {
		var constraint *pgconn.PgError
		if errors.As(err, &constraint) && constraint.Code == "23514" {
			return out, ErrNOWPurchaseCannotCancel
		}
		return out, err
	}
	if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='security_blocked',updated_at=now() WHERE attempt_id=$1::uuid`, orderID); err != nil {
		return out, err
	}
	if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET checkout_open=false,updated_at=now() WHERE id=$1::uuid`, orderID); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
