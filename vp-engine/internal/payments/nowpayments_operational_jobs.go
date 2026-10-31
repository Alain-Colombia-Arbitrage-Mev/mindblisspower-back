package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

const nowJobPath = "/api/payments/internal/nowpayments/run"
const nowReadyPath = "/api/payments/internal/nowpayments/ready"

var errNOWJobRunning = errors.New("NOW job is already running")

func (s *Store) enqueueNOWOperationalPayment(ctx context.Context, environment, orderID, paymentID, digest string) (bool, error) {
	if !s.nowOperational || !validNOWPaymentsOrderID(orderID) {
		return false, nil
	}
	tag, err := s.db.Exec(ctx, `INSERT INTO payments.nowpayments_operational_job(attempt_id,capture_id)
 SELECT o.attempt_id,c.id FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id
 JOIN payments.nowpayments_webhook_capture c ON c.matched_attempt_id=o.attempt_id AND c.environment=a.environment
 WHERE a.id=$1::uuid AND a.environment=$2 AND c.payment_id=$3 AND c.body_sha256=$4 ORDER BY c.id DESC LIMIT 1
 ON CONFLICT(attempt_id) DO UPDATE SET capture_id=EXCLUDED.capture_id,state=CASE WHEN payments.nowpayments_operational_job.state='held' THEN 'held' ELSE 'queued' END,
 available_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE payments.nowpayments_operational_job.capture_id<EXCLUDED.capture_id`, orderID, environment, paymentID, digest)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() > 0 {
		return true, nil
	}
	var exists bool
	err = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_operational_job WHERE attempt_id=$1::uuid)`, orderID).Scan(&exists)
	return exists, err
}

// RunNOWOperationalJobs claims at most five durable jobs. Leases permit recovery
// after container termination; payment/order locks make delivery idempotent.
func (s *Store) RunNOWOperationalJobs(ctx context.Context, limit int) (int, error) {
	if !s.nowOperational {
		return 0, ErrNOWOperationalPlan
	}
	if limit < 1 || limit > 5 {
		limit = 5
	}
	processed := 0
	var failures []error
	for range limit {
		var orderID, token string
		var captureID int64
		err := s.db.QueryRow(ctx, `WITH pick AS(SELECT attempt_id FROM payments.nowpayments_operational_job WHERE available_at<=now()
   AND(state='queued' OR(state='running' AND lease_until<=now())) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE payments.nowpayments_operational_job j SET state='running',lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=attempts+1,updated_at=now()
   FROM pick WHERE j.attempt_id=pick.attempt_id RETURNING j.attempt_id::text,j.capture_id,j.lease_token::text`).Scan(&orderID, &captureID, &token)
		if errors.Is(err, pgx.ErrNoRows) {
			return processed, errors.Join(failures...)
		}
		if err != nil {
			return processed, err
		}
		var environment, digest, signedJSON, apiJSON string
		err = s.db.QueryRow(ctx, `SELECT environment,body_sha256,signed_evidence::text,api_evidence::text FROM payments.nowpayments_webhook_capture WHERE id=$1 AND matched_attempt_id=$2::uuid AND disposition='matched'`, captureID, orderID).Scan(&environment, &digest, &signedJSON, &apiJSON)
		var signed, api nowpayments.Payment
		if err == nil {
			err = json.Unmarshal([]byte(signedJSON), &signed)
		}
		if err == nil {
			err = json.Unmarshal([]byte(apiJSON), &api)
		}
		var state string
		if err == nil {
			state, err = s.processNOWOperationalPayment(ctx, environment, signed, api, digest)
		}
		if err != nil {
			if errors.Is(err, ErrCheckoutIdentityReview) || errors.Is(err, ErrNOWPaymentsEvidence) {
				state, code := "security_blocked", "identity_review_required"
				if errors.Is(err, ErrNOWPaymentsEvidence) {
					state, code = "risk_review", "payment_evidence_review_required"
				}
				if _, holdErr := s.db.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state=$2,updated_at=now() WHERE attempt_id=$1::uuid AND state='awaiting_payment'`, orderID, state); holdErr != nil {
					return processed, holdErr
				}
				if _, holdErr := s.db.Exec(ctx, `UPDATE payments.nowpayments_operational_job SET state='held',lease_token=NULL,lease_until=NULL,last_error_code=$4,updated_at=now() WHERE attempt_id=$1::uuid AND capture_id=$2 AND lease_token=$3::uuid`, orderID, captureID, token, code); holdErr != nil {
					return processed, holdErr
				}
				processed++
				continue
			}
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
			_, retryErr := s.db.Exec(cleanup, `UPDATE payments.nowpayments_operational_job SET state='queued',available_at=now()+least(attempts*5,300)*interval '1 second',lease_token=NULL,lease_until=NULL,last_error_code='processing_unavailable',updated_at=now() WHERE attempt_id=$1::uuid AND capture_id=$2 AND lease_token=$3::uuid`, orderID, captureID, token)
			cancel()
			if retryErr != nil {
				return processed, retryErr
			}
			failures = append(failures, err)
			if ctx.Err() != nil {
				return processed, errors.Join(failures...)
			}
			continue
		}
		next := "completed"
		holdCode := "payment_evidence_review_required"
		if state == "risk_review" || state == "security_blocked" {
			next = "held"
			if state == "security_blocked" {
				holdCode = "identity_review_required"
			}
		}
		if _, err = s.db.Exec(ctx, `UPDATE payments.nowpayments_operational_job SET state=$4,lease_token=NULL,lease_until=NULL,last_error_code=CASE WHEN $4='held' THEN COALESCE(last_error_code,$5) ELSE NULL END,updated_at=now() WHERE attempt_id=$1::uuid AND capture_id=$2 AND lease_token=$3::uuid`, orderID, captureID, token, next, holdCode); err != nil {
			return processed, err
		}
		processed++
	}
	return processed, errors.Join(failures...)
}

type nowOperationalJobRunner struct {
	mu  sync.Mutex
	run func(context.Context) (int, error)
}

func (h *Handler) SetNOWOperationalJobRunner(run func(context.Context) (int, error)) {
	h.nowJobs = &nowOperationalJobRunner{run: run}
}

func (h *Handler) RunNOWOperationalJobs(ctx context.Context) (int, error) {
	if h.nowJobs == nil || h.nowJobs.run == nil {
		return 0, ErrNOWOperationalPlan
	}
	if !h.nowJobs.mu.TryLock() {
		return 0, errNOWJobRunning
	}
	defer h.nowJobs.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	return h.nowJobs.run(ctx)
}

func (h *Handler) handleNOWOperationalJobs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodPost || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	processed, err := h.RunNOWOperationalJobs(r.Context())
	if errors.Is(err, errNOWJobRunning) {
		writeJSON(w, http.StatusAccepted, map[string]any{"running": true})
		return
	}
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments_job_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"processed": processed, "engine_run": true})
}

func (h *Handler) SetNOWOperationalReadinessRunner(run func(context.Context) error) { h.nowReady = run }

func (h *Handler) handleNOWOperationalReadiness(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	if h.nowReady == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments_not_ready")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := h.nowReady(ctx); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments_not_ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "engine_schema": 1})
}
