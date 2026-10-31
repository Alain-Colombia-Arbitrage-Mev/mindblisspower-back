package payments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

var (
	ErrNOWPaymentsOutstanding      = errors.New("NOWPayments membership purchase already outstanding")
	ErrNOWPaymentsAttemptNotFound  = errors.New("NOWPayments membership purchase not found")
	ErrNOWPaymentsEvidence         = errors.New("NOWPayments membership evidence requires review")
	ErrNOWPaymentsActiveMembership = errors.New("membership already active")
	nowPaymentsIDPattern           = regexp.MustCompile(`^[1-9][0-9]{0,63}$`)
	nowPaymentsSHA256Pattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Email must already come from a verified, bound service identity. The database
// independently requires the explicit Better Auth binding; it never provisions
// a person or claims a legacy network node by matching an unbound email.
type NOWPaymentsMembershipInput struct {
	Email, Environment string
	Subject            string // Bound JWT subject provided only by the verified HTTP identity.
	PackageID          int
	SponsorAffiliateID *int64
	PreferredSide      string
	PurchaseRequestID  string // One explicit purchase intent, retained across retries.
}

type NOWPaymentsMembershipAttempt struct {
	ID, Environment, AuthSubject, PersonPublicID      string
	PersonID                                          int64
	AffiliateID, SponsorAffiliateID                   *int64
	PackageID, PV                                     int
	PackageName, AmountUSD, FeeUSD                    string
	PricingPolicy, ProviderCostUSD, CommissionBaseUSD string
	TotalCents                                        int64
	PreferredSide, State, InvoiceID, PaymentID        string
	Reused                                            bool // Internal: never call the provider for this attempt.
	Reusable                                          bool // Internal: independently checked unpaid snapshot.
}

type NOWPaymentsReceiptResult struct {
	State                                 string
	Finished, Duplicate, MultiplePayments bool
}

func validNOWPaymentsEnvironment(value string) bool {
	return value == "production" || value == "sandbox"
}

func validNOWPaymentsOrderID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

const nowPaymentsAttemptColumns = `id::text,environment,auth_subject,person_public_id::text,person_id,
 affiliate_id,sponsor_affiliate_id,package_id,pv,package_name,amount_usd::text,fee_usd::text,
 total_cents,COALESCE(preferred_side,''),state,COALESCE(invoice_id,''),COALESCE(payment_id,''),
 COALESCE(pricing_policy,''),COALESCE(provider_cost_usd::text,''),COALESCE(commission_base_usd::text,'')`

func scanNOWPaymentsAttempt(row pgx.Row) (NOWPaymentsMembershipAttempt, error) {
	var out NOWPaymentsMembershipAttempt
	err := row.Scan(&out.ID, &out.Environment, &out.AuthSubject, &out.PersonPublicID, &out.PersonID,
		&out.AffiliateID, &out.SponsorAffiliateID, &out.PackageID, &out.PV, &out.PackageName, &out.AmountUSD,
		&out.FeeUSD, &out.TotalCents, &out.PreferredSide, &out.State, &out.InvoiceID, &out.PaymentID,
		&out.PricingPolicy, &out.ProviderCostUSD, &out.CommissionBaseUSD)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNOWPaymentsAttemptNotFound
	}
	return out, err
}

func (s *Store) LookupNOWPaymentsMembership(ctx context.Context, orderID, environment string) (NOWPaymentsMembershipAttempt, error) {
	if !validNOWPaymentsEnvironment(environment) || !validNOWPaymentsOrderID(orderID) {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsEvidence
	}
	return scanNOWPaymentsAttempt(s.db.QueryRow(ctx, `SELECT `+nowPaymentsAttemptColumns+`
 FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid AND environment=$2`, orderID, environment))
}

// CreateNOWPaymentsMembership commits the immutable order before any external
// invoice request. A conflict never starts a second provider request, including
// after a timeout whose actual provider outcome is unknown.
func (s *Store) CreateNOWPaymentsMembership(ctx context.Context, in NOWPaymentsMembershipInput) (NOWPaymentsMembershipAttempt, error) {
	// Retrying a rolled-back serialization failure is local-only. The external
	// invoice is requested only after this function commits a genuinely new order.
	for range 3 {
		out, err := s.createNOWPaymentsMembership(ctx, in)
		var conflict *pgconn.PgError
		if !errors.As(err, &conflict) || conflict.Code != "40001" {
			return out, err
		}
	}
	return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsOutstanding
}

func (s *Store) createNOWPaymentsMembership(ctx context.Context, in NOWPaymentsMembershipInput) (NOWPaymentsMembershipAttempt, error) {
	if s.nowOperational && !validNOWPaymentsOrderID(in.PurchaseRequestID) {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPurchaseRequestInvalid
	}
	if err := s.requireNOWMembershipMode(ctx); err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	if !validNOWPaymentsEnvironment(in.Environment) || in.PackageID <= 0 || strings.TrimSpace(in.Email) == "" ||
		(in.PreferredSide != "" && normalizePreferredSide(in.PreferredSide) == "") || (in.SponsorAffiliateID != nil && *in.SponsorAffiliateID <= 0) {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsEvidence
	}
	if strings.TrimSpace(in.Subject) == "" {
		return NOWPaymentsMembershipAttempt{}, ErrCheckoutIdentityReview
	}
	options := pgx.TxOptions{}
	if s.nowOperational {
		options.IsoLevel = pgx.RepeatableRead
	}
	tx, err := s.db.BeginTx(ctx, options)
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, fmt.Errorf("begin NOWPayments order: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var subject, publicID string
	var personID int64
	var affiliateID, existingSponsor *int64
	err = tx.QueryRow(ctx, `SELECT b.subject,p.public_id::text,p.id,a.id,a.sponsor_id
 FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject JOIN mlm.person p ON p.id=b.person_id
 LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE b.provider='better_auth' AND b.subject=$2 AND p.user_id=b.subject AND u.email_verified=true
   AND lower(btrim(u.email))=lower(btrim(p.email::text)) AND lower(btrim(p.email::text))=$1
   AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND lower(btrim(other.email::text))=$1)
   AND p.status::text IN ('active','pending') AND NOT COALESCE(p.blacklisted,false)
   AND (a.id IS NULL OR a.status::text='active') FOR NO KEY UPDATE OF p`, strings.ToLower(strings.TrimSpace(in.Email)), in.Subject).
		Scan(&subject, &publicID, &personID, &affiliateID, &existingSponsor)
	if err != nil || !validNOWPaymentsOrderID(publicID) {
		return NOWPaymentsMembershipAttempt{}, ErrCheckoutIdentityReview
	}
	if err := checkoutOutstanding(ctx, tx, personID, in.PackageID, "nowpayments"); err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	if s.nowOperational {
		allowed, err := nowPurchaseCollectionAllowed(ctx, tx, personID, in.Email)
		if err != nil {
			return NOWPaymentsMembershipAttempt{}, err
		}
		if !allowed {
			return NOWPaymentsMembershipAttempt{}, ErrCheckoutIdentityReview
		}
		if reused, found, err := lookupNOWPurchaseRequest(ctx, tx, in, personID, publicID); found || err != nil {
			if err != nil {
				return NOWPaymentsMembershipAttempt{}, err
			}
			return reused, tx.Commit(ctx)
		}
	}
	// Existing placements always win over referral input.
	if affiliateID != nil {
		in.SponsorAffiliateID = existingSponsor
		in.PreferredSide = ""
	}
	if in.SponsorAffiliateID != nil {
		eligible, err := sponsorCanReceivePlacement(ctx, tx, *in.SponsorAffiliateID)
		if err != nil {
			return NOWPaymentsMembershipAttempt{}, fmt.Errorf("verify NOWPayments sponsor: %w", err)
		}
		if !eligible {
			return NOWPaymentsMembershipAttempt{}, ErrCheckoutIdentityReview
		}
	}
	var active bool
	if !s.nowOperational {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mlm.affiliate a
 JOIN mlm.affiliate_package ap ON ap.affiliate_id=a.id LEFT JOIN mlm.package_cap_state cs ON cs.affiliate_package_id=ap.id
 WHERE a.person_id=$1 AND ap.package_id=$2 AND ap.status='active' AND cs.closed_at IS NULL)`, personID, in.PackageID).Scan(&active); err != nil {
			return NOWPaymentsMembershipAttempt{}, fmt.Errorf("verify NOWPayments active membership: %w", err)
		}
		if active {
			return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsActiveMembership
		}
	}
	var pack Pack
	var amount string
	packQuery := `SELECT id,name,amount_usd::text,pv FROM mlm.package WHERE id=$1 AND is_active`
	if !s.nowOperational {
		packQuery += " FOR SHARE"
	}
	if err := tx.QueryRow(ctx, packQuery, in.PackageID).
		Scan(&pack.ID, &pack.Name, &amount, &pack.PV); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NOWPaymentsMembershipAttempt{}, ErrPackNotFound
		}
		return NOWPaymentsMembershipAttempt{}, fmt.Errorf("snapshot NOWPayments package: %w", err)
	}
	pack.AmountUSD, err = decimal.NewFromString(amount)
	if err != nil || pack.PV < 0 || len(pack.Name) == 0 || len(pack.Name) > 256 {
		return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsEvidence
	}
	pricing, err := nowPaymentsPrice(pack.AmountUSD)
	if err != nil {
		return NOWPaymentsMembershipAttempt{}, err
	}
	out, err := scanNOWPaymentsAttempt(tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_membership_attempt
 (environment,auth_subject,person_id,person_public_id,affiliate_id,sponsor_affiliate_id,preferred_side,
 package_id,package_name,pv,amount_usd,fee_usd,total_cents,pricing_policy,provider_cost_usd,commission_base_usd)
 VALUES($1,$2,$3,$4::uuid,$5,$6,NULLIF($7,''),$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING `+nowPaymentsAttemptColumns,
		in.Environment, subject, personID, publicID, affiliateID, in.SponsorAffiliateID, normalizePreferredSide(in.PreferredSide),
		pack.ID, pack.Name, pack.PV, pricing.AmountUSD, pricing.FeeUSD, pricing.TotalCents,
		pricing.Policy, pricing.ProviderCostUSD, pricing.CommissionBaseUSD))
	if err != nil {
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.Code == "23505" {
			return NOWPaymentsMembershipAttempt{}, ErrNOWPaymentsOutstanding
		}
		return NOWPaymentsMembershipAttempt{}, fmt.Errorf("persist NOWPayments order: %w", err)
	}
	if s.nowOperational {
		if err := s.prepareNOWOperationalOrder(ctx, tx, out); err != nil {
			return NOWPaymentsMembershipAttempt{}, err
		}
		if err := bindNOWPurchaseRequest(ctx, tx, in, out.ID); err != nil {
			return NOWPaymentsMembershipAttempt{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return NOWPaymentsMembershipAttempt{}, fmt.Errorf("commit NOWPayments order: %w", err)
	}
	return out, nil
}

func (s *Store) resolveNOWBuyer(ctx context.Context, subject, email string) (Buyer, error) {
	var buyer Buyer
	err := s.db.QueryRow(ctx, `SELECT p.id,a.id,a.sponsor_id FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject
 JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE b.subject=$1 AND b.provider='better_auth' AND u.email_verified AND lower(btrim(u.email))=$2 AND lower(btrim(p.email::text))=$2
 AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND lower(btrim(other.email::text))=$2)`, subject, email).Scan(&buyer.PersonID, &buyer.AffiliateID, &buyer.SponsorAffiliateID)
	if err != nil {
		return Buyer{}, ErrCheckoutIdentityReview
	}
	return buyer, nil
}

func (s *Store) AttachNOWPaymentsInvoice(ctx context.Context, orderID, environment, invoiceID string) error {
	if err := s.requireNOWMembershipMode(ctx); err != nil {
		return err
	}
	if !validNOWPaymentsOrderID(orderID) || !validNOWPaymentsEnvironment(environment) || !nowPaymentsIDPattern.MatchString(invoiceID) {
		return ErrNOWPaymentsEvidence
	}
	tag, err := s.db.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET invoice_id=$3,state='invoice_created',updated_at=now()
 WHERE id=$1::uuid AND environment=$2 AND state='creating_invoice' AND invoice_id IS NULL`, orderID, environment, invoiceID)
	if err != nil {
		return fmt.Errorf("attach NOWPayments invoice: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNOWPaymentsEvidence
	}
	return nil
}

func (s *Store) MarkNOWPaymentsInvoiceUnknown(ctx context.Context, orderID, environment string) error {
	if err := s.requireNOWMembershipMode(ctx); err != nil {
		return err
	}
	if !validNOWPaymentsOrderID(orderID) || !validNOWPaymentsEnvironment(environment) {
		return ErrNOWPaymentsEvidence
	}
	tag, err := s.db.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET state='invoice_unknown',review_reason='create_unconfirmed',updated_at=now()
 WHERE id=$1::uuid AND environment=$2 AND state='creating_invoice' AND invoice_id IS NULL`, orderID, environment)
	if err != nil {
		return fmt.Errorf("mark NOWPayments invoice unknown: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNOWPaymentsEvidence
	}
	return nil
}

// matchingNOWPaymentsEvidence compares independently authenticated sources to
// a persisted invoice. Signature verification and GetPayment MUST precede this
// method in the handler. No browser redirect or client amount is evidence.
func matchingNOWPaymentsEvidence(attempt NOWPaymentsMembershipAttempt, signed, api nowpayments.Payment) error {
	if attempt.InvoiceID == "" || signed.OrderID != attempt.ID || api.OrderID != attempt.ID ||
		string(signed.InvoiceID) != attempt.InvoiceID || string(api.InvoiceID) != attempt.InvoiceID ||
		!nowPaymentsIDPattern.MatchString(string(signed.PaymentID)) || signed.PaymentID != api.PaymentID ||
		signed.PriceCurrency != "usd" || api.PriceCurrency != "usd" || signed.Status == "" || api.Status == "" ||
		len(signed.Status) > 64 || len(api.Status) > 64 {
		return ErrNOWPaymentsEvidence
	}
	want := decimal.NewFromInt(attempt.TotalCents).Div(decimal.NewFromInt(100))
	for _, p := range []nowpayments.Payment{signed, api} {
		if len(p.PriceAmount) > 512 || len(p.PayAmount) > 512 || len(p.ActuallyPaid) > 512 || len(p.OutcomeAmount) > 512 || len(p.PayCurrency) > 64 || len(p.OutcomeCurrency) > 64 {
			return ErrNOWPaymentsEvidence
		}
		amount, err := decimal.NewFromString(string(p.PriceAmount))
		if err != nil || amount.Exponent() < -1000 || amount.Exponent() > 1000 || !amount.Equal(want) {
			return ErrNOWPaymentsEvidence
		}
	}
	return nil
}

// RecordNOWPaymentsReceipt only records membership evidence requiring review.
// It never activates a package, posts wallet/commission/PV entries, repositions
// the tree, sends an activation email or writes Stripe-recovery relations.
func (s *Store) RecordNOWPaymentsReceipt(ctx context.Context, environment string, signed, api nowpayments.Payment, bodySHA256 string) (NOWPaymentsReceiptResult, error) {
	if err := s.requireNOWMembershipMode(ctx); err != nil {
		return NOWPaymentsReceiptResult{}, err
	}
	if !validNOWPaymentsEnvironment(environment) || !validNOWPaymentsOrderID(signed.OrderID) || !nowPaymentsSHA256Pattern.MatchString(bodySHA256) {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return NOWPaymentsReceiptResult{}, fmt.Errorf("begin NOWPayments evidence: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	attempt, err := scanNOWPaymentsAttempt(tx.QueryRow(ctx, `SELECT `+nowPaymentsAttemptColumns+`
 FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid AND environment=$2 FOR UPDATE`, signed.OrderID, environment))
	if err != nil {
		return NOWPaymentsReceiptResult{}, err
	}
	if attempt.State == "closed_reviewed" || matchingNOWPaymentsEvidence(attempt, signed, api) != nil {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	_, err = tx.Exec(ctx, `INSERT INTO payments.nowpayments_payment_binding(environment,payment_id,attempt_id)
 VALUES($1,$2,$3::uuid) ON CONFLICT(environment,payment_id) DO NOTHING`, environment, string(api.PaymentID), attempt.ID)
	if err != nil {
		return NOWPaymentsReceiptResult{}, fmt.Errorf("bind NOWPayments payment: %w", err)
	}
	var owner string
	if err := tx.QueryRow(ctx, `SELECT attempt_id::text FROM payments.nowpayments_payment_binding WHERE environment=$1 AND payment_id=$2`, environment, string(api.PaymentID)).Scan(&owner); err != nil {
		return NOWPaymentsReceiptResult{}, fmt.Errorf("read NOWPayments payment binding: %w", err)
	}
	if owner != attempt.ID {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	multiple := attempt.PaymentID != "" && attempt.PaymentID != string(api.PaymentID)
	if attempt.PaymentID == "" {
		if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET payment_id=$3 WHERE id=$1::uuid AND environment=$2 AND payment_id IS NULL`, attempt.ID, environment, string(api.PaymentID)); err != nil {
			return NOWPaymentsReceiptResult{}, fmt.Errorf("attach NOWPayments payment: %w", err)
		}
	}
	validation := nowpayments.ValidateFinished(api, nowpayments.ExpectedPayment{OrderID: attempt.ID, InvoiceID: attempt.InvoiceID, PaymentID: string(api.PaymentID), AmountUSDMinor: attempt.TotalCents})
	finished := validation == nil
	if validation != nil && !errors.Is(validation, nowpayments.ErrNotFinished) {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	signedJSON, err := json.Marshal(signed)
	if err != nil {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	apiJSON, err := json.Marshal(api)
	if err != nil {
		return NOWPaymentsReceiptResult{}, ErrNOWPaymentsEvidence
	}
	apiDigest := sha256.Sum256(apiJSON)
	apiSHA256 := hex.EncodeToString(apiDigest[:])
	tag, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_membership_receipt
 (attempt_id,environment,payment_id,body_sha256,api_sha256,signed_evidence,api_evidence,finished_verified,multiple_payments)
 VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) ON CONFLICT(environment,payment_id,body_sha256,api_sha256) DO NOTHING`,
		attempt.ID, environment, string(api.PaymentID), bodySHA256, apiSHA256, string(signedJSON), string(apiJSON), finished, multiple)
	if err != nil {
		return NOWPaymentsReceiptResult{}, fmt.Errorf("persist NOWPayments receipt: %w", err)
	}
	duplicate := tag.RowsAffected() == 0
	// A duplicate receipt must not erase a later risk decision or change its
	// historical verified outcome because the provider API moved meanwhile.
	if duplicate {
		if err := tx.QueryRow(ctx, `SELECT finished_verified,multiple_payments FROM payments.nowpayments_membership_receipt
 WHERE environment=$1 AND payment_id=$2 AND body_sha256=$3 AND api_sha256=$4`, environment, string(api.PaymentID), bodySHA256, apiSHA256).Scan(&finished, &multiple); err != nil {
			return NOWPaymentsReceiptResult{}, fmt.Errorf("read NOWPayments duplicate receipt: %w", err)
		}
	} else {
		reason, state := nowPaymentsReviewState(attempt.State, api.Status, finished, multiple)
		if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET state=$3,updated_at=now(),
 review_reason=CASE WHEN review_reason IN ('multiple_payments','provider_risk')
   OR (review_reason='finished_membership_review' AND $4='provider_nonfinal') THEN review_reason ELSE $4 END
 WHERE id=$1::uuid AND environment=$2`, attempt.ID, environment, state, reason); err != nil {
			return NOWPaymentsReceiptResult{}, fmt.Errorf("update NOWPayments review state: %w", err)
		}
		attempt.State = state
	}
	if err := tx.Commit(ctx); err != nil {
		return NOWPaymentsReceiptResult{}, fmt.Errorf("commit NOWPayments receipt: %w", err)
	}
	return NOWPaymentsReceiptResult{State: attempt.State, Finished: finished, Duplicate: duplicate, MultiplePayments: multiple}, nil
}

func nowPaymentsReviewState(previous, status string, finished, multiple bool) (reason, state string) {
	reason, state = "provider_nonfinal", previous
	if multiple {
		return "multiple_payments", "pending_review"
	}
	if finished {
		return "finished_membership_review", "pending_review"
	}
	switch status {
	case "waiting", "confirming", "confirmed", "sending":
		// Non-final events never downgrade a finished or risk review.
	default:
		return "provider_risk", "pending_review"
	}
	return reason, state
}
