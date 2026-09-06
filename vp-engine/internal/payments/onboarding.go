package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// MemberOnboarding contiene los datos privados capturados durante el onboarding.
// La tabla correspondiente no concede acceso a roles de reportes/read-only.
type MemberOnboarding struct {
	City                  string     `json:"city"`
	DocumentType          string     `json:"document_type"`
	DocumentNumber        string     `json:"document_number"`
	BirthDate             string     `json:"birth_date"`
	Address               string     `json:"address"`
	PreferredLanguage     string     `json:"preferred_language"`
	CommunicationChannel  string     `json:"communication_channel"`
	MemberInterest        string     `json:"member_interest"`
	SupportNeeds          string     `json:"support_needs"`
	AcceptsPrivacy        bool       `json:"accepts_privacy"`
	AcceptsCommunications bool       `json:"accepts_communications"`
	CompletedAt           *time.Time `json:"completed_at,omitempty"`
}

type onboardingUpdateReq struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Phone   string `json:"phone"`
	Country string `json:"country"`
	MemberOnboarding
}

// GetMemberOnboarding lee únicamente el perfil del miembro autenticado.
func (s *Store) GetMemberOnboarding(ctx context.Context, email string) (MemberOnboarding, error) {
	var o MemberOnboarding
	var city, documentType, documentNumber, address, supportNeeds *string
	var birthDate *time.Time
	err := s.reader().QueryRow(ctx, `
		SELECT o.city, o.document_type, o.document_number, o.birth_date, o.address,
		       o.preferred_language, o.communication_channel, o.member_interest,
		       o.support_needs, o.accepts_privacy, o.accepts_communications, o.completed_at
		  FROM mlm.member_onboarding o
		  JOIN mlm.person p ON p.id = o.person_id
		 WHERE lower(p.email) = lower($1)
		 LIMIT 1
	`, email).Scan(
		&city, &documentType, &documentNumber, &birthDate, &address,
		&o.PreferredLanguage, &o.CommunicationChannel, &o.MemberInterest,
		&supportNeeds, &o.AcceptsPrivacy, &o.AcceptsCommunications, &o.CompletedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberOnboarding{}, ErrBuyerNotFound
	}
	if err != nil {
		return MemberOnboarding{}, fmt.Errorf("get member onboarding: %w", err)
	}
	if city != nil {
		o.City = strings.TrimSpace(*city)
	}
	if documentType != nil {
		o.DocumentType = strings.TrimSpace(*documentType)
	}
	if documentNumber != nil {
		o.DocumentNumber = strings.TrimSpace(*documentNumber)
	}
	if birthDate != nil {
		o.BirthDate = birthDate.Format("2006-01-02")
	}
	if address != nil {
		o.Address = strings.TrimSpace(*address)
	}
	if supportNeeds != nil {
		o.SupportNeeds = strings.TrimSpace(*supportNeeds)
	}
	return o, nil
}

// SaveMemberOnboarding actualiza mlm.person y el perfil privado en una sola
// transacción. No toca payout_wallet_usdc ni otros campos financieros.
func (s *Store) SaveMemberOnboarding(
	ctx context.Context,
	email, first, last, phone, country string,
	o MemberOnboarding,
) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin member onboarding: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var personID int64
	err = tx.QueryRow(ctx, `
		UPDATE mlm.person
		   SET first_name = $2, last_name = $3, phone_number = $4,
		       country = NULLIF($5, ''), updated_at = now()
		 WHERE lower(email) = lower($1)
		 RETURNING id
	`, email, first, last, phone, country).Scan(&personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBuyerNotFound
	}
	if err != nil {
		return fmt.Errorf("update onboarding person: %w", err)
	}

	var birthDate any
	if o.BirthDate != "" {
		parsed, parseErr := time.Parse("2006-01-02", o.BirthDate)
		if parseErr != nil {
			return fmt.Errorf("parse validated birth date: %w", parseErr)
		}
		birthDate = parsed
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO mlm.member_onboarding (
		  person_id, city, document_type, document_number, birth_date, address,
		  preferred_language, communication_channel, member_interest, support_needs,
		  accepts_privacy, accepts_communications, privacy_accepted_at, completed_at
		) VALUES (
		  $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), $5, NULLIF($6,''),
		  $7, $8, $9, NULLIF($10,''), $11, $12,
		  CASE WHEN $11 THEN now() ELSE NULL END, now()
		)
		ON CONFLICT (person_id) DO UPDATE SET
		  city = EXCLUDED.city,
		  document_type = EXCLUDED.document_type,
		  document_number = EXCLUDED.document_number,
		  birth_date = EXCLUDED.birth_date,
		  address = EXCLUDED.address,
		  preferred_language = EXCLUDED.preferred_language,
		  communication_channel = EXCLUDED.communication_channel,
		  member_interest = EXCLUDED.member_interest,
		  support_needs = EXCLUDED.support_needs,
		  accepts_privacy = EXCLUDED.accepts_privacy,
		  accepts_communications = EXCLUDED.accepts_communications,
		  privacy_accepted_at = COALESCE(mlm.member_onboarding.privacy_accepted_at, EXCLUDED.privacy_accepted_at),
		  completed_at = now(),
		  updated_at = now()
	`, personID, o.City, o.DocumentType, o.DocumentNumber, birthDate, o.Address,
		o.PreferredLanguage, o.CommunicationChannel, o.MemberInterest, o.SupportNeeds,
		o.AcceptsPrivacy, o.AcceptsCommunications)
	if err != nil {
		return fmt.Errorf("upsert member onboarding: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit member onboarding: %w", err)
	}

	s.cache.del(ctx, "refctx:"+strings.ToLower(strings.TrimSpace(email)))
	return nil
}

func (h *Handler) handleMemberOnboarding(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}

	if r.Method == http.MethodGet {
		email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
		if !ok {
			return
		}
		if h.rejectIfSuspended(r.Context(), w, email) {
			return
		}
		o, err := h.store.GetMemberOnboarding(r.Context(), email)
		if errors.Is(err, ErrBuyerNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{})
			return
		}
		if err != nil {
			h.log.Error().Err(err).Msg("get member onboarding")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, o)
		return
	}

	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, "json_required")
		return
	}

	var req onboardingUpdateReq
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
		return
	}

	normalizeMemberOnboarding(&req)
	if reason := validateMemberOnboarding(req, time.Now().UTC()); reason != "" {
		writeErr(w, http.StatusBadRequest, reason)
		return
	}
	first, last := splitName(req.Name, email)
	if _, err := h.store.EnsurePerson(r.Context(), email, req.Name, req.Phone); err != nil {
		h.log.Error().Err(err).Msg("onboarding ensure person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if err := h.store.SaveMemberOnboarding(
		r.Context(), email, first, last, req.Phone, req.Country, req.MemberOnboarding,
	); err != nil {
		h.log.Error().Err(err).Msg("save member onboarding")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func normalizeMemberOnboarding(req *onboardingUpdateReq) {
	req.Email = strings.TrimSpace(req.Email)
	req.Name = strings.TrimSpace(req.Name)
	req.Phone = strings.TrimSpace(req.Phone)
	req.Country = strings.TrimSpace(req.Country)
	req.City = strings.TrimSpace(req.City)
	req.DocumentType = strings.ToLower(strings.TrimSpace(req.DocumentType))
	req.DocumentNumber = strings.TrimSpace(req.DocumentNumber)
	req.BirthDate = strings.TrimSpace(req.BirthDate)
	req.Address = strings.TrimSpace(req.Address)
	req.PreferredLanguage = strings.ToLower(strings.TrimSpace(req.PreferredLanguage))
	req.CommunicationChannel = strings.ToLower(strings.TrimSpace(req.CommunicationChannel))
	req.MemberInterest = strings.ToLower(strings.TrimSpace(req.MemberInterest))
	req.SupportNeeds = strings.TrimSpace(req.SupportNeeds)
	if req.DocumentNumber == "" {
		req.DocumentType = ""
	}
}

func validateMemberOnboarding(req onboardingUpdateReq, now time.Time) string {
	if !lengthBetween(req.Name, 1, 120) {
		return "invalid_name"
	}
	if !lengthBetween(req.Phone, 1, 32) {
		return "invalid_phone"
	}
	if !lengthBetween(req.Country, 1, 80) || !lengthBetween(req.City, 1, 120) {
		return "invalid_location"
	}
	if req.DocumentNumber != "" {
		if !oneOf(req.DocumentType, "cc", "ce", "passport", "dni") || !validDocumentNumber(req.DocumentNumber) {
			return "invalid_document"
		}
	}
	if req.BirthDate != "" {
		birthDate, err := time.Parse("2006-01-02", req.BirthDate)
		if err != nil || birthDate.After(now) || birthDate.Before(now.AddDate(-120, 0, 0)) {
			return "invalid_birth_date"
		}
	}
	if utf8.RuneCountInString(req.Address) > 240 {
		return "invalid_address"
	}
	if !oneOf(req.PreferredLanguage, "es", "en", "pt") {
		return "invalid_language"
	}
	if !oneOf(req.CommunicationChannel, "whatsapp", "email", "phone") {
		return "invalid_communication_channel"
	}
	if !oneOf(req.MemberInterest, "wellbeing", "products", "community", "education") {
		return "invalid_member_interest"
	}
	if utf8.RuneCountInString(req.SupportNeeds) > 1000 {
		return "invalid_support_needs"
	}
	if !req.AcceptsPrivacy {
		return "privacy_required"
	}
	return ""
}

func lengthBetween(value string, min, max int) bool {
	n := utf8.RuneCountInString(value)
	return n >= min && n <= max
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func validDocumentNumber(value string) bool {
	if !lengthBetween(value, 3, 40) {
		return false
	}
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' || r == '.' || r == '/' {
			continue
		}
		return false
	}
	return true
}
