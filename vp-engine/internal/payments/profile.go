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
	var p MemberProfile
	var first, last, phone, country, wallet *string
	err := s.reader().QueryRow(ctx, `
		SELECT first_name, last_name, phone_number, country, payout_wallet_usdc
		  FROM mlm.person WHERE lower(email) = lower($1) LIMIT 1
	`, email).Scan(&first, &last, &phone, &country, &wallet)
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberProfile{}, ErrBuyerNotFound
	}
	if err != nil {
		return MemberProfile{}, fmt.Errorf("get profile: %w", err)
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

// UpdateProfile actualiza los campos editables. Devuelve filas afectadas.
func (s *Store) UpdateProfile(ctx context.Context, email string, p MemberProfile) (int64, error) {
	phone := strings.TrimSpace(p.Phone)
	if phone == "" {
		phone = "-"
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE mlm.person
		   SET first_name = $2, last_name = $3, phone_number = $4,
		       country = NULLIF($5,''), payout_wallet_usdc = NULLIF($6,''),
		       updated_at = now()
		 WHERE lower(email) = lower($1)
	`, email, strings.TrimSpace(p.FirstName), strings.TrimSpace(p.LastName), phone,
		strings.TrimSpace(p.Country), strings.TrimSpace(p.PayoutWalletUSDC))
	if err != nil {
		return 0, fmt.Errorf("update profile: %w", err)
	}
	// Invalida el nombre+código cacheados (GetMemberContext) para que el sidebar
	// y la sesión reflejen el nombre editado de inmediato (no tras 10 min).
	s.cache.del(ctx, "refctx:"+strings.ToLower(strings.TrimSpace(email)))
	return tag.RowsAffected(), nil
}

type profileUpdateReq struct {
	Email            string `json:"email"`
	Name             string `json:"name"` // "Nombre completo" del form (se parte en first/last)
	FirstName        string `json:"first_name"`
	LastName         string `json:"last_name"`
	Phone            string `json:"phone"`
	Country          string `json:"country"`
	PayoutWalletUSDC string `json:"payout_wallet_usdc"`
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

	var req profileUpdateReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}

	// "Nombre completo" → first/last si no vienen separados.
	first, last := strings.TrimSpace(req.FirstName), strings.TrimSpace(req.LastName)
	if first == "" && last == "" && strings.TrimSpace(req.Name) != "" {
		first, last = splitName(req.Name, email)
	}

	wallet := strings.TrimSpace(req.PayoutWalletUSDC)
	if wallet != "" && !usdcWalletRe.MatchString(wallet) {
		writeErr(w, http.StatusBadRequest, "invalid_wallet")
		return
	}

	// Auto-provisión: crea la persona si el usuario aún no compró.
	if _, err := h.store.EnsurePerson(r.Context(), email, strings.TrimSpace(first+" "+last), req.Phone); err != nil {
		h.log.Error().Err(err).Msg("profile ensure person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	prof := MemberProfile{FirstName: first, LastName: last, Phone: req.Phone, Country: req.Country, PayoutWalletUSDC: wallet}
	n, err := h.store.UpdateProfile(r.Context(), email, prof)
	if err != nil {
		h.log.Error().Err(err).Msg("update profile")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if n == 0 {
		writeErr(w, http.StatusNotFound, "person_not_found")
		return
	}
	saved, _ := h.store.GetProfile(r.Context(), email)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": saved})
}
