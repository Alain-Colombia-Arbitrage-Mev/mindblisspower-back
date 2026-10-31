package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Perfil del miembro: datos personales editables + billetera de retiro USDC.
// El botón "Guardar cambios" de /dashboard/profile llama POST /api/member/profile.

var usdcWalletRe = regexp.MustCompile(`^0x[a-fA-F0-9]{40}$`)

// MemberProfile son los campos editables del perfil.
type MemberProfile struct {
	FirstName        string `json:"first_name"`
	LastName         string `json:"last_name"`
	Phone            string `json:"phone"`
	Country          string `json:"country"`
	PayoutWalletUSDC string `json:"payout_wallet_usdc"`
}

// GetProfile devuelve los campos editables del perfil por email.
func (s *Store) GetProfile(ctx context.Context, email string) (MemberProfile, error) {
	return scanMemberProfile(s.reader().QueryRow(ctx, `
		SELECT first_name, last_name, phone_number, country, payout_wallet_usdc
		  FROM mlm.person WHERE lower(email) = lower($1) LIMIT 1
	`, email))
}

func scanMemberProfile(row pgx.Row) (MemberProfile, error) {
	var p MemberProfile
	var first, last, phone, country, wallet *string
	err := row.Scan(&first, &last, &phone, &country, &wallet)
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberProfile{}, ErrBuyerNotFound
	}
	if err != nil {
		return MemberProfile{}, fmt.Errorf("read profile: %w", err)
	}
	if first != nil {
		p.FirstName = strings.TrimSpace(*first)
	}
	if last != nil {
		p.LastName = strings.TrimSpace(*last)
	}
	if phone != nil && *phone != "-" {
		p.Phone = strings.TrimSpace(*phone)
	}
	if country != nil {
		p.Country = strings.TrimSpace(*country)
	}
	if wallet != nil {
		p.PayoutWalletUSDC = strings.TrimSpace(*wallet)
	}
	return p, nil
}

// Nil means leave unchanged. KYC submits only a name; replacing the entire row
// there used to erase the phone, country and payout wallet.
type memberProfilePatch struct {
	FirstName, LastName, Phone, Country, PayoutWalletUSDC *string
}

const updateMemberProfileSQL = `
		UPDATE mlm.person
		   SET first_name = COALESCE($2::text, first_name),
		       last_name = COALESCE($3::text, last_name),
		       phone_number = COALESCE($4::text, phone_number),
		       country = CASE WHEN $5::text IS NULL THEN country ELSE NULLIF($5::text,'') END,
		       payout_wallet_usdc = CASE WHEN $6::text IS NULL THEN payout_wallet_usdc ELSE NULLIF($6::text,'') END,
		       updated_at = now()
		 WHERE lower(email) = lower($1)
		 RETURNING first_name, last_name, phone_number, country, payout_wallet_usdc`

// One presence-aware statement avoids read/merge/write lost updates. RETURNING
// also returns the saved row without a potentially stale replica round-trip.
func updateMemberProfile(ctx context.Context, q rowQuerier, email string, p memberProfilePatch) (MemberProfile, error) {
	return scanMemberProfile(q.QueryRow(ctx, updateMemberProfileSQL, email,
		p.FirstName, p.LastName, p.Phone, p.Country, p.PayoutWalletUSDC))
}

func (s *Store) updateProfile(ctx context.Context, email string, p memberProfilePatch) (MemberProfile, error) {
	profile, err := updateMemberProfile(ctx, s.db, email, p)
	if err != nil {
		return MemberProfile{}, fmt.Errorf("update profile: %w", err)
	}
	// Invalida el nombre+código cacheados (GetMemberContext) para que el sidebar
	// y la sesión reflejen el nombre editado de inmediato (no tras 10 min).
	s.cache.del(ctx, "refctx:"+strings.ToLower(strings.TrimSpace(email)))
	s.treeReads.invalidate()
	return profile, nil
}

type profileUpdateReq struct {
	Email            string  `json:"email"`
	Name             *string `json:"name"` // "Nombre completo" del form (se parte en first/last)
	FirstName        *string `json:"first_name"`
	LastName         *string `json:"last_name"`
	Phone            *string `json:"phone"`
	Country          *string `json:"country"`
	PayoutWalletUSDC *string `json:"payout_wallet_usdc"`
}

func profilePatch(req profileUpdateReq) (memberProfilePatch, string) {
	trim := func(value *string) *string {
		if value == nil {
			return nil
		}
		clean := strings.TrimSpace(*value)
		return &clean
	}
	p := memberProfilePatch{FirstName: trim(req.FirstName), LastName: trim(req.LastName),
		Phone: trim(req.Phone), Country: trim(req.Country), PayoutWalletUSDC: trim(req.PayoutWalletUSDC)}
	if req.Name != nil && req.FirstName == nil && req.LastName == nil {
		first, last := "", ""
		if strings.TrimSpace(*req.Name) != "" {
			first, last = splitName(*req.Name, req.Email)
		}
		p.FirstName, p.LastName = &first, &last
	}
	if p.FirstName == nil && p.LastName == nil && p.Phone == nil && p.Country == nil && p.PayoutWalletUSDC == nil {
		return p, "missing_profile_fields"
	}
	if p.Phone != nil && *p.Phone == "" {
		empty := "-"
		p.Phone = &empty
	}
	if p.PayoutWalletUSDC != nil && *p.PayoutWalletUSDC != "" && !usdcWalletRe.MatchString(*p.PayoutWalletUSDC) {
		return p, "invalid_wallet"
	}
	return p, ""
}

func decodeProfileUpdate(reader io.Reader) (profileUpdateReq, error) {
	var req *profileUpdateReq
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return profileUpdateReq{}, err
	}
	if req == nil {
		return profileUpdateReq{}, errors.New("profile object required")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return profileUpdateReq{}, errors.New("one profile object required")
	}
	return *req, nil
}

// handleMemberProfile: GET devuelve el perfil; POST lo actualiza (con auto-provisión).
func (h *Handler) handleMemberProfile(w http.ResponseWriter, r *http.Request) {
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
		p, err := h.store.GetProfile(r.Context(), email)
		if errors.Is(err, ErrBuyerNotFound) {
			writeJSON(w, http.StatusOK, MemberProfile{}) // registrado sin persona aún
			return
		}
		if err != nil {
			h.log.Error().Err(err).Msg("get profile")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, p)
		return
	}

	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}

	req, err := decodeProfileUpdate(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil {
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

	// "Nombre completo" → first/last si no vienen separados.
	patch, invalid := profilePatch(req)
	if invalid != "" {
		writeErr(w, http.StatusBadRequest, invalid)
		return
	}

	// Auto-provisión: crea la persona si el usuario aún no compró.
	value := func(field *string) string {
		if field == nil {
			return ""
		}
		return *field
	}
	if _, err := h.store.EnsurePerson(r.Context(), email, strings.TrimSpace(value(patch.FirstName)+" "+value(patch.LastName)), value(patch.Phone)); err != nil {
		h.log.Error().Err(err).Msg("profile ensure person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	prof, err := h.store.updateProfile(r.Context(), email, patch)
	if errors.Is(err, ErrBuyerNotFound) {
		writeErr(w, http.StatusNotFound, "person_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("update profile")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Devolvemos los valores recién guardados (no una re-lectura de la réplica,
	// que por lag podría devolver datos viejos o vacíos y parecer que no guardó).
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": prof})
}
