package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const verifiedReferralPath = "/api/payments/referral-attribution"

var errReferralBlocked = errors.New("referral owner restricted")

type VerifiedReferralAttribution struct {
	OK            bool   `json:"ok"`
	Ref           string `json:"ref"`
	PreferredSide string `json:"preferred_side"`
	Positioned    bool   `json:"positioned"`
}

type verifiedReferralPersistence interface {
	VerifiedRegistrationReferral(context.Context, string, string, *string, string) (VerifiedReferralAttribution, error)
}

// Same priority/uniqueness policy as the verified persistence function. Keep
// this checkout-only: legacy administrative reports retain their existing API.
func (s *Store) resolveVerifiedCheckoutSponsor(ctx context.Context, code string) (*int64, error) {
	if !validVerifiedReferralCode(code) {
		return nil, ErrInvalidReferralCode
	}
	var mpID int64
	if match := mpCodeRe.FindStringSubmatch(code); match != nil {
		var parseErr error
		mpID, parseErr = strconv.ParseInt(match[1], 10, 64)
		if parseErr != nil || mpID < 1 {
			mpID = 0
		}
	}
	var sponsor *int64
	var count int64
	err := s.db.QueryRow(ctx, `WITH candidates AS (
 SELECT a.id,CASE WHEN a.invitation_link=$1 THEN 1 WHEN lower(a.invitation_link)=lower($1) THEN 2 ELSE 3 END AS priority
 FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id
 WHERE (lower(a.invitation_link)=lower($1) OR ($2>0 AND a.id=$2)) AND `+placementSponsorEligibilitySQL+`
 ) SELECT min(c.id),count(*) FROM candidates c
 WHERE c.priority=(SELECT min(c2.priority) FROM candidates c2)`, code, mpID).Scan(&sponsor, &count)
	if err != nil {
		return nil, err
	}
	if count > 1 {
		return nil, ErrInvalidReferralCode
	}
	return sponsor, nil
}

// A positioned owner needs no referral-writing capability to confirm that the
// existing position is immutable. Keep the live canonical binding, verified
// email, duplicate-email and account/affiliate restrictions on this read; the
// caller separately checks the existing blacklist policy before reaching it.
// No sponsor, stale browser hint or registration_referral row is consulted.
const verifiedReferralPositionSQL = `SELECT a.id IS NOT NULL
 FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject
 JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
 LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE b.subject=$1 AND b.provider='better_auth' AND u.email_verified
 AND lower(btrim(u.email))=$2 AND lower(btrim(p.email::text))=$2
 AND p.status::text IN('active','pending') AND NOT COALESCE(p.blacklisted,false)
 AND NOT EXISTS(SELECT 1 FROM mlm.affiliate restricted WHERE restricted.person_id=p.id
 AND restricted.status::text IN('suspended','banned','deleted'))
 AND NOT EXISTS(SELECT 1 FROM mlm.person other
 WHERE other.id<>p.id AND lower(btrim(other.email::text))=$2)`

func verifiedReferralPosition(ctx context.Context, q banQuerier, subject, email string) (bool, error) {
	var positioned bool
	err := q.QueryRow(ctx, verifiedReferralPositionSQL, subject, email).Scan(&positioned)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrCheckoutIdentityReview
	}
	return positioned, err
}

// Only the reviewed function receives EXECUTE for metadata writes and reads of
// an unpositioned owner's hint. Positioned GET uses SELECT only. Runtime still
// has no INSERT/UPDATE on registration_referral, identities or financial tables.
func (s *Store) VerifiedRegistrationReferral(ctx context.Context, subject, email string, ref *string, side string) (VerifiedReferralAttribution, error) {
	decision, err := s.BanDecisionFor(ctx, BanCandidate{Email: email})
	if err != nil {
		return VerifiedReferralAttribution{}, err
	}
	if decision.Blocked {
		return VerifiedReferralAttribution{}, errReferralBlocked
	}
	if ref == nil {
		positioned, err := verifiedReferralPosition(ctx, s.db, subject, email)
		if err != nil {
			return VerifiedReferralAttribution{}, err
		}
		if positioned {
			return VerifiedReferralAttribution{OK: true, Positioned: true}, nil
		}
	} else if _, err := s.resolveNOWBuyer(ctx, subject, email); err != nil {
		return VerifiedReferralAttribution{}, err
	}
	var out VerifiedReferralAttribution
	err = s.db.QueryRow(ctx, `SELECT referral_code,preferred_side,positioned
 FROM payments.verified_registration_referral($1,$2,$3,$4)`, subject, email, ref, side).
		Scan(&out.Ref, &out.PreferredSide, &out.Positioned)
	if err != nil {
		var pgerr *pgconn.PgError
		if errors.As(err, &pgerr) && pgerr.Code == "P0001" {
			switch pgerr.Message {
			case "referral_identity_review":
				return out, ErrCheckoutIdentityReview
			case "referral_owner_restricted":
				return out, errReferralBlocked
			case "invalid_referral_code":
				return out, ErrInvalidReferralCode
			}
		}
		return out, err
	}
	out.OK = true
	return out, nil
}

func validVerifiedReferralEmail(email string) bool {
	if email == "" || len(email) > 254 || email != strings.ToLower(strings.TrimSpace(email)) {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email && parsed.Name == "" && strings.Contains(email, "@")
}

func validVerifiedReferralCode(ref string) bool {
	if !utf8.ValidString(ref) || utf8.RuneCountInString(ref) < 1 || utf8.RuneCountInString(ref) > 64 {
		return false
	}
	for _, ch := range ref {
		if unicode.IsSpace(ch) || unicode.IsControl(ch) {
			return false
		}
	}
	return true
}

type verifiedReferralInput struct {
	Email string `json:"email"`
	Ref   string `json:"ref"`
	Side  string `json:"preferred_side"`
}

func decodeVerifiedReferral(w http.ResponseWriter, r *http.Request) (verifiedReferralInput, bool) {
	var in verifiedReferralInput
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || r.Header.Get("Content-Encoding") != "" {
		writeErr(w, http.StatusUnsupportedMediaType, "json_required")
		return in, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || !utf8.Valid(body) || json.Unmarshal(body, &in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid_referral_request")
		return in, false
	}
	// BFF sends these three literal keys in this order. Canonical JSON rejects
	// duplicate/unknown/escaped keys and null/omitted values consistently with Core.
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(in)
	var compact bytes.Buffer
	if json.Compact(&compact, body) != nil || !bytes.Equal(compact.Bytes(), bytes.TrimSpace(canonical.Bytes())) ||
		!validVerifiedReferralEmail(in.Email) || !validVerifiedReferralCode(in.Ref) || (in.Side != "" && in.Side != "L" && in.Side != "R") {
		writeErr(w, http.StatusBadRequest, "invalid_referral_request")
		return in, false
	}
	return in, true
}

func (h *Handler) handleVerifiedReferral(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.URL.Path != verifiedReferralPath || r.URL.RawPath != "" || r.URL.ForceQuery ||
		(r.Method != http.MethodGet && r.Method != http.MethodPost) {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	verifier, ok := h.verifier.(nowSubjectVerifier)
	_, actAs := r.Header[http.CanonicalHeaderKey(actAsHeader)]
	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if !h.requireVerified || !ok || raw == "" || len(raw) > 16384 || actAs {
		writeErr(w, http.StatusUnauthorized, "id_token_required")
		return
	}
	subject, email, err := verifier.VerifySubject(r.Context(), raw)
	if err != nil {
		// Private Go -> BFF classification. The portal does not forward this
		// header to customers; it contains only a fixed enum, never an identity.
		w.Header().Set("X-Mindbliss-Identity-Reason", identityFailureReason(err))
	}
	if writeAuthenticationUnavailable(w, err) {
		return
	}
	if err != nil || strings.TrimSpace(subject) == "" || !validVerifiedReferralEmail(email) {
		writeErr(w, http.StatusUnauthorized, "invalid_id_token")
		return
	}
	var claimed, side string
	var ref *string
	if r.Method == http.MethodGet {
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || !strings.HasPrefix(r.URL.RawQuery, "email=") || len(query) != 1 || len(query["email"]) != 1 || !validVerifiedReferralEmail(query.Get("email")) || r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
			writeErr(w, http.StatusBadRequest, "invalid_referral_request")
			return
		}
		claimed = query.Get("email")
	} else {
		if r.URL.RawQuery != "" {
			writeErr(w, http.StatusBadRequest, "invalid_referral_request")
			return
		}
		in, ok := decodeVerifiedReferral(w, r)
		if !ok {
			return
		}
		claimed, ref, side = in.Email, &in.Ref, in.Side
	}
	if claimed != email {
		writeErr(w, http.StatusForbidden, "identity_mismatch")
		return
	}
	persistence := h.referralPersistence
	if persistence == nil && h.store != nil {
		persistence = h.store
	}
	if persistence == nil {
		writeErr(w, http.StatusServiceUnavailable, "referral_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := persistence.VerifiedRegistrationReferral(ctx, subject, email, ref, side)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidReferralCode):
			writeErr(w, http.StatusBadRequest, "invalid_referral_code")
		case errors.Is(err, ErrCheckoutIdentityReview):
			writeErr(w, http.StatusForbidden, "identity_link_review")
		case errors.Is(err, errReferralBlocked):
			writeErr(w, http.StatusForbidden, "account_suspended")
		default:
			writeErr(w, http.StatusServiceUnavailable, "referral_unavailable")
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}
