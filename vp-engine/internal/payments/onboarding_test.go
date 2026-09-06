package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func validOnboardingRequest() onboardingUpdateReq {
	return onboardingUpdateReq{
		Email:   "member@example.com",
		Name:    "Miembro Ejemplo",
		Phone:   "+573001112233",
		Country: "Colombia",
		MemberOnboarding: MemberOnboarding{
			City:                  "Bogotá",
			DocumentType:          "cc",
			DocumentNumber:        "123456789",
			BirthDate:             "1990-06-15",
			Address:               "Carrera 1 # 2-3",
			PreferredLanguage:     "es",
			CommunicationChannel:  "whatsapp",
			MemberInterest:        "community",
			SupportNeeds:          "Prefiere contacto en la tarde.",
			AcceptsPrivacy:        true,
			AcceptsCommunications: true,
		},
	}
}

func TestValidateMemberOnboarding(t *testing.T) {
	now := time.Date(2026, time.September, 6, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*onboardingUpdateReq)
		want   string
	}{
		{name: "valid", mutate: func(*onboardingUpdateReq) {}, want: ""},
		{name: "privacy required", mutate: func(r *onboardingUpdateReq) { r.AcceptsPrivacy = false }, want: "privacy_required"},
		{name: "future birth date", mutate: func(r *onboardingUpdateReq) { r.BirthDate = "2027-01-01" }, want: "invalid_birth_date"},
		{name: "unsupported document", mutate: func(r *onboardingUpdateReq) { r.DocumentType = "other" }, want: "invalid_document"},
		{name: "document metacharacters", mutate: func(r *onboardingUpdateReq) { r.DocumentNumber = "123<script>" }, want: "invalid_document"},
		{name: "long support notes", mutate: func(r *onboardingUpdateReq) { r.SupportNeeds = string(make([]byte, 1001)) }, want: "invalid_support_needs"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := validOnboardingRequest()
			tt.mutate(&req)
			if got := validateMemberOnboarding(req, now); got != tt.want {
				t.Fatalf("validateMemberOnboarding() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNormalizeMemberOnboardingDropsDocumentTypeWithoutNumber(t *testing.T) {
	req := validOnboardingRequest()
	req.DocumentNumber = "  "
	normalizeMemberOnboarding(&req)
	if req.DocumentType != "" {
		t.Fatalf("DocumentType = %q, want empty", req.DocumentType)
	}
}

func TestMemberOnboardingHandlerSecurity(t *testing.T) {
	body, err := json.Marshal(validOnboardingRequest())
	if err != nil {
		t.Fatal(err)
	}
	newRequest := func(payload []byte) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/member/onboarding", bytes.NewReader(payload))
		r.Header.Set("Content-Type", "application/json")
		return r
	}

	t.Run("requires service authentication", func(t *testing.T) {
		h := &Handler{serviceToken: "service-secret", log: zerolog.Nop()}
		w := httptest.NewRecorder()
		h.handleMemberOnboarding(w, newRequest(body))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("requires verified member token in strict mode", func(t *testing.T) {
		h := &Handler{serviceToken: "service-secret", log: zerolog.Nop()}
		h.SetIdentityVerifier(fakeVerifier{email: "member@example.com"}, true)
		r := newRequest(body)
		r.Header.Set("X-VP-Service-Token", "service-secret")
		w := httptest.NewRecorder()
		h.handleMemberOnboarding(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("rejects a claimed identity different from the token", func(t *testing.T) {
		req := validOnboardingRequest()
		req.Email = "attacker@example.com"
		mismatchBody, marshalErr := json.Marshal(req)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		h := &Handler{serviceToken: "service-secret", log: zerolog.Nop()}
		h.SetIdentityVerifier(fakeVerifier{email: "victim@example.com"}, true)
		r := newRequest(mismatchBody)
		r.Header.Set("X-VP-Service-Token", "service-secret")
		r.Header.Set(idTokenHeader, "valid-token")
		w := httptest.NewRecorder()
		h.handleMemberOnboarding(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", w.Code)
		}
	})

	t.Run("rejects unknown JSON fields", func(t *testing.T) {
		h := &Handler{serviceToken: "service-secret", log: zerolog.Nop()}
		r := newRequest(append(body[:len(body)-1], []byte(`,"admin":true}`)...))
		r.Header.Set("X-VP-Service-Token", "service-secret")
		w := httptest.NewRecorder()
		h.handleMemberOnboarding(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})
}

func TestMemberOnboardingRoundTrip(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)

	personID, err := store.EnsurePerson(ctx, "onboarding@test.local", "Onboarding Member", "+573001112233")
	if err != nil {
		t.Fatalf("EnsurePerson: %v", err)
	}
	if personID == 0 {
		t.Fatal("EnsurePerson returned an empty id")
	}

	req := validOnboardingRequest()
	if err := store.SaveMemberOnboarding(
		ctx,
		"onboarding@test.local",
		"Updated",
		"Member",
		req.Phone,
		req.Country,
		req.MemberOnboarding,
	); err != nil {
		t.Fatalf("SaveMemberOnboarding: %v", err)
	}

	got, err := store.GetMemberOnboarding(ctx, "ONBOARDING@test.local")
	if err != nil {
		t.Fatalf("GetMemberOnboarding: %v", err)
	}
	if got.DocumentNumber != req.DocumentNumber || got.BirthDate != req.BirthDate || got.Address != req.Address {
		t.Fatalf("sensitive profile did not round-trip: %#v", got)
	}
	if got.CompletedAt == nil || !got.AcceptsPrivacy {
		t.Fatalf("completion metadata missing: %#v", got)
	}

	var first, last, country string
	var wallet *string
	if err := pool.QueryRow(ctx, `
		SELECT first_name, last_name, country, payout_wallet_usdc
		FROM mlm.person WHERE id=$1
	`, personID).Scan(&first, &last, &country, &wallet); err != nil {
		t.Fatalf("read updated person: %v", err)
	}
	if first != "Updated" || last != "Member" || country != "Colombia" {
		t.Fatalf("person profile not updated: first=%q last=%q country=%q", first, last, country)
	}
	if wallet != nil {
		t.Fatalf("payout wallet changed unexpectedly: %v", *wallet)
	}
}
