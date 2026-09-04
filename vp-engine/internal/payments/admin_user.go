package payments

// Inspector de usuario del panel admin: ficha completa (GET), edición de
// identidad (PUT), soft-delete (DELETE, solo super_admin) y mini resumen del
// subárbol (GET branch-tree). Todo pasa por el service token + identidad
// verificada; el borrado exige rol super_admin y confirmación explícita.
//
// NOTA schema: mlm.person NO tiene columna de dirección ni país de residencia —
// el "phone" de la ficha es mlm.person.phone_number y el campo address se omite
// a propósito (no inventamos columnas).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// emailFmtRe: validación mínima de formato de email (algo@dominio.tld).
var emailFmtRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// maxBranchAggDownline: umbral sano para la agregación de dinero por closure.
// Con ramas más grandes que esto (toda la red ronda ~121k) el SUM sobre
// wallet_movement de todos los descendientes se vuelve caro; devolvemos los
// contadores denormalizados igual y marcamos agg_skipped para que el front lo
// muestre como "no calculado".
const maxBranchAggDownline = 100_000

// ── Tipos de la ficha ────────────────────────────────────────────────────────

// AdminUserPerson: identidad de la ficha del inspector.
type AdminUserPerson struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	Alias       string `json:"alias"`
	Email       string `json:"email"`
	Phone       string `json:"phone"` // mlm.person.phone_number (sin address: no existe en el schema)
	Status      string `json:"status"`
	Blacklisted bool   `json:"blacklisted"`
	KYCStatus   string `json:"kyc_status"`
	IsAdmin     bool   `json:"is_admin"`
	CreatedAt   string `json:"created_at"`
}

// AdminUserRank es la referencia de rango de un afiliado.
type AdminUserRank struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// AdminUserSponsor es la referencia al patrocinador de un afiliado.
type AdminUserSponsor struct {
	ID     int64  `json:"id"`
	Handle string `json:"handle"`
	Name   string `json:"name"`
}

// AdminUserAffiliate: posición(es) del usuario en el árbol. person_id es UNIQUE
// en mlm.affiliate, así que en la práctica es 0 o 1 fila; se expone como lista
// por simetría con el contrato del front.
type AdminUserAffiliate struct {
	ID       int64             `json:"id"`
	Handle   string            `json:"handle"`
	Placed   bool              `json:"placed"`
	ParentID *int64            `json:"parent_id"`
	Side     *string           `json:"side"` // "L" | "R" | null (root)
	Depth    int               `json:"depth"`
	Status   string            `json:"status"`
	Rank     *AdminUserRank    `json:"rank"`
	Sponsor  *AdminUserSponsor `json:"sponsor"`

	// Agregados denormalizados (no viajan en JSON aquí; alimentan branch).
	leftCount, rightCount int64
	leftPV, rightPV       string
}

// AdminUserWallet: saldo por asset (USD y USD-RET).
type AdminUserWallet struct {
	Symbol  string `json:"symbol"`
	Balance string `json:"balance"`
}

// AdminUserMovement: movimiento reciente del ledger del afiliado principal.
type AdminUserMovement struct {
	Concept  string `json:"concept"` // mlm.concept.kind
	Amount   string `json:"amount"`
	PostedAt string `json:"posted_at"`
}

// AdminUserBranch: resumen de la rama del primer afiliado colocado.
type AdminUserBranch struct {
	AffiliateID    int64  `json:"affiliate_id"`
	DownlineTotal  int64  `json:"downline_total"`
	DownlineLeft   int64  `json:"downline_left"`
	DownlineRight  int64  `json:"downline_right"`
	PVLeft         string `json:"pv_left"`
	PVRight        string `json:"pv_right"`
	SalesUSD       string `json:"branch_sales_usd"`
	CommissionsUSD string `json:"branch_commissions_usd"`
	AggSkipped     bool   `json:"agg_skipped,omitempty"`
}

// ── Store: lecturas de la ficha ──────────────────────────────────────────────

// GetAdminUserPerson busca la persona por id (>0) o, si personID<=0, por email.
// found=false si no existe.
func (s *Store) GetAdminUserPerson(ctx context.Context, personID int64, email string) (AdminUserPerson, bool, error) {
	var p AdminUserPerson
	err := s.reader().QueryRow(ctx, `
		SELECT p.id,
		       trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
		       coalesce(p.first_name,''), coalesce(p.last_name,''), coalesce(p.alias,''),
		       p.email::text, coalesce(p.phone_number,''),
		       p.status::text, coalesce(p.blacklisted,false), p.kyc_status::text,
		       coalesce(p.is_admin,false),
		       to_char(p.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM mlm.person p
		 WHERE ($1 > 0 AND p.id = $1)
		    OR ($1 <= 0 AND lower(p.email) = lower($2))
		 LIMIT 1
	`, personID, email).Scan(&p.ID, &p.Name, &p.FirstName, &p.LastName, &p.Alias,
		&p.Email, &p.Phone, &p.Status, &p.Blacklisted, &p.KYCStatus, &p.IsAdmin, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, fmt.Errorf("admin user person: %w", err)
	}
	return p, true, nil
}

// ListPersonAffiliates devuelve las posiciones del usuario con rango y sponsor.
func (s *Store) ListPersonAffiliates(ctx context.Context, personID int64) ([]AdminUserAffiliate, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT a.id,
		       COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       a.parent_id, a.position::text, a.depth, a.status::text,
		       a.left_count, a.right_count,
		       a.left_pv_lifetime::text, a.right_pv_lifetime::text,
		       r.code, r.name_es,
		       sp.id, COALESCE(NULLIF(sp.invitation_link,''), 'MP'||sp.id),
		       trim(coalesce(spp.first_name,'')||' '||coalesce(spp.last_name,''))
		  FROM mlm.affiliate a
		  LEFT JOIN mlm.rank r       ON r.id = a.current_rank_id
		  LEFT JOIN mlm.affiliate sp ON sp.id = a.sponsor_id
		  LEFT JOIN mlm.person spp   ON spp.id = sp.person_id
		 WHERE a.person_id = $1
		 ORDER BY a.id
	`, personID)
	if err != nil {
		return nil, fmt.Errorf("list person affiliates: %w", err)
	}
	defer rows.Close()

	out := []AdminUserAffiliate{}
	for rows.Next() {
		var a AdminUserAffiliate
		var rankCode, rankName *string
		var spID *int64
		var spHandle, spName *string
		if err := rows.Scan(&a.ID, &a.Handle, &a.ParentID, &a.Side, &a.Depth, &a.Status,
			&a.leftCount, &a.rightCount, &a.leftPV, &a.rightPV,
			&rankCode, &rankName, &spID, &spHandle, &spName); err != nil {
			return nil, fmt.Errorf("scan person affiliate: %w", err)
		}
		// Colocado = tiene padre, o es root (depth 0 sin padre). Toda fila de
		// affiliate tiene path/depth, así que en la práctica siempre es true.
		a.Placed = a.ParentID != nil || a.Depth == 0
		if rankCode != nil {
			a.Rank = &AdminUserRank{Code: *rankCode, Name: derefStr(rankName)}
		}
		if spID != nil {
			a.Sponsor = &AdminUserSponsor{ID: *spID, Handle: derefStr(spHandle), Name: derefStr(spName)}
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListPersonWallets devuelve los saldos por asset de todas las posiciones.
func (s *Store) ListPersonWallets(ctx context.Context, personID int64) ([]AdminUserWallet, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT ast.symbol, w.balance::text
		  FROM mlm.wallet w
		  JOIN mlm.asset ast    ON ast.id = w.asset_id
		  JOIN mlm.affiliate a  ON a.id = w.affiliate_id
		 WHERE a.person_id = $1
		 ORDER BY ast.symbol
	`, personID)
	if err != nil {
		return nil, fmt.Errorf("list person wallets: %w", err)
	}
	defer rows.Close()
	out := []AdminUserWallet{}
	for rows.Next() {
		var w AdminUserWallet
		if err := rows.Scan(&w.Symbol, &w.Balance); err != nil {
			return nil, fmt.Errorf("scan wallet: %w", err)
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// RecentAffiliateMovements devuelve los últimos movimientos del ledger de un
// afiliado (kind del concepto, monto firmado, fecha).
func (s *Store) RecentAffiliateMovements(ctx context.Context, affiliateID int64, limit int) ([]AdminUserMovement, error) {
	if limit <= 0 || limit > 100 {
		limit = 15
	}
	rows, err := s.reader().Query(ctx, `
		SELECT c.kind::text, wm.amount::text,
		       to_char(wm.posted_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE wm.affiliate_id = $1
		 ORDER BY wm.posted_at DESC
		 LIMIT $2
	`, affiliateID, limit)
	if err != nil {
		return nil, fmt.Errorf("recent movements: %w", err)
	}
	defer rows.Close()
	out := []AdminUserMovement{}
	for rows.Next() {
		var m AdminUserMovement
		if err := rows.Scan(&m.Concept, &m.Amount, &m.PostedAt); err != nil {
			return nil, fmt.Errorf("scan movement: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// PersonPackageCounts devuelve paquetes activos y totales del usuario.
func (s *Store) PersonPackageCounts(ctx context.Context, personID int64) (active, total int, err error) {
	err = s.reader().QueryRow(ctx, `
		SELECT COALESCE(count(*) FILTER (WHERE ap.status='active'),0), count(*)
		  FROM mlm.affiliate_package ap
		  JOIN mlm.affiliate a ON a.id = ap.affiliate_id
		 WHERE a.person_id = $1
	`, personID).Scan(&active, &total)
	if err != nil {
		return 0, 0, fmt.Errorf("person package counts: %w", err)
	}
	return active, total, nil
}

// BranchMoney agrega, en UNA sola query index-backed por la closure, las ventas
// (kind package_purchase, débito → se reporta en positivo) y las comisiones de
// bono (binary_bonus, leadership_bonus, direct_bonus — los kinds de bono que
// existen en mlm.concept_kind) de los DESCENDIENTES (distance>0) del afiliado.
func (s *Store) BranchMoney(ctx context.Context, affiliateID int64) (salesUSD, commissionsUSD string, err error) {
	err = s.reader().QueryRow(ctx, `
		SELECT COALESCE(SUM(ABS(wm.amount)) FILTER (WHERE c.kind = 'package_purchase'), 0)::text,
		       COALESCE(SUM(ABS(wm.amount)) FILTER (WHERE c.kind IN ('binary_bonus','leadership_bonus','direct_bonus')), 0)::text
		  FROM mlm.affiliate_closure cl
		  JOIN mlm.wallet_movement wm ON wm.affiliate_id = cl.descendant_id
		  JOIN mlm.concept c          ON c.id = wm.concept_id
		 WHERE cl.ancestor_id = $1
		   AND cl.distance > 0
		   AND c.kind IN ('package_purchase','binary_bonus','leadership_bonus','direct_bonus')
	`, affiliateID).Scan(&salesUSD, &commissionsUSD)
	if err != nil {
		return "", "", fmt.Errorf("branch money: %w", err)
	}
	return salesUSD, commissionsUSD, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ── Store: edición y borrado ─────────────────────────────────────────────────

// EmailTakenByOther: true si otra persona no-borrada ya usa ese email
// (comparación lower(btrim())).
func (s *Store) EmailTakenByOther(ctx context.Context, email string, personID int64) (bool, error) {
	var taken bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM mlm.person
			 WHERE lower(btrim(email::text)) = lower(btrim($1))
			   AND id <> $2
			   AND status <> 'deleted'
		)`, email, personID).Scan(&taken)
	if err != nil {
		return false, fmt.Errorf("email taken: %w", err)
	}
	return taken, nil
}

// UpdatePersonIdentity actualiza solo los campos presentes (nil ⇒ conservar,
// vía COALESCE). Si cambia el email, también mueve los purchase_intent ligados a
// la persona para que panel y dashboard sigan mostrando pagos históricos.
// Devuelve filas de persona y filas de purchase_intent afectadas.
func (s *Store) UpdatePersonIdentity(ctx context.Context, personID int64, firstName, lastName, email, phone *string) (int64, int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("update person identity begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var prevEmail string
	err = tx.QueryRow(ctx, `SELECT email::text FROM mlm.person WHERE id = $1 FOR UPDATE`, personID).Scan(&prevEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("lookup person identity: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE mlm.person
		   SET first_name   = COALESCE($2, first_name),
		       last_name    = COALESCE($3, last_name),
		       email        = COALESCE($4::citext, email),
		       phone_number = COALESCE($5, phone_number),
		       updated_at   = now()
		 WHERE id = $1
	`, personID, firstName, lastName, email, phone)
	if err != nil {
		return 0, 0, fmt.Errorf("update person identity: %w", err)
	}

	var paymentRows int64
	if email != nil && !strings.EqualFold(strings.TrimSpace(prevEmail), strings.TrimSpace(*email)) {
		ptag, err := tx.Exec(ctx, `
			UPDATE payments.purchase_intent
			   SET user_id = $2, updated_at = now()
			 WHERE person_id = $1
			    OR (person_id IS NULL AND lower(user_id) = lower($3))
		`, personID, *email, prevEmail)
		if err != nil {
			return 0, 0, fmt.Errorf("update purchase intent email: %w", err)
		}
		paymentRows = ptag.RowsAffected()
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, fmt.Errorf("update person identity commit: %w", err)
	}
	return tag.RowsAffected(), paymentRows, nil
}

// PersonDeleteGuards: condiciones que impiden el soft-delete automático —
// alguna wallet con saldo > 0 o algún paquete activo (requieren decisión humana).
func (s *Store) PersonDeleteGuards(ctx context.Context, personID int64) (hasBalance, hasActivePackage bool, err error) {
	err = s.db.QueryRow(ctx, `
		SELECT EXISTS (
		         SELECT 1 FROM mlm.wallet w
		           JOIN mlm.affiliate a ON a.id = w.affiliate_id
		          WHERE a.person_id = $1 AND w.balance > 0),
		       EXISTS (
		         SELECT 1 FROM mlm.affiliate_package ap
		           JOIN mlm.affiliate a ON a.id = ap.affiliate_id
		          WHERE a.person_id = $1 AND ap.status = 'active')
	`, personID).Scan(&hasBalance, &hasActivePackage)
	if err != nil {
		return false, false, fmt.Errorf("person delete guards: %w", err)
	}
	return hasBalance, hasActivePackage, nil
}

// SoftDeletePerson marca persona y afiliados como 'deleted' en una transacción.
// NO toca parent_id ni la closure: el nodo queda inerte en su lugar, igual que
// los soft-deleted existentes (el árbol binario no se re-cablea).
func (s *Store) SoftDeletePerson(ctx context.Context, personID int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("soft delete begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.person SET status='deleted', updated_at=now() WHERE id=$1
	`, personID); err != nil {
		return fmt.Errorf("soft delete person: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.affiliate SET status='deleted', updated_at=now() WHERE person_id=$1
	`, personID); err != nil {
		return fmt.Errorf("soft delete affiliates: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("soft delete commit: %w", err)
	}
	return nil
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// handleAdminUser despacha /api/admin/user por método:
//
//	GET    → ficha completa (?person_id=N o ?email=..., person_id precede)
//	PUT    → editar identidad (admin)
//	DELETE → soft-delete (solo super_admin, confirm="DELETE")
func (h *Handler) handleAdminUser(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleAdminUserGet(w, r)
	case http.MethodPut:
		h.handleAdminUserUpdate(w, r)
	case http.MethodDelete:
		h.handleAdminUserDelete(w, r)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// handleAdminUserGet arma la ficha del inspector.
func (h *Handler) handleAdminUserGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	ctx := r.Context()
	personID, _ := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("person_id")), 10, 64)
	targetEmail := strings.TrimSpace(r.URL.Query().Get("target_email"))
	if targetEmail == "" {
		// La query "email" la consume resolveIdentity (identidad del admin); para
		// buscar por email del usuario se acepta target_email o, si no colisiona
		// con la identidad, el propio email cuando viene person_id vacío.
		targetEmail = strings.TrimSpace(r.URL.Query().Get("q_email"))
	}
	if personID <= 0 && targetEmail == "" {
		writeErr(w, http.StatusBadRequest, "missing_person_id_or_email")
		return
	}

	person, found, err := h.store.GetAdminUserPerson(ctx, personID, targetEmail)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user: person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}

	// Cognito (best-effort, degrada a exists:null si no está configurado o falla).
	type cognitoInfo struct {
		Exists  *bool  `json:"exists"`
		Enabled bool   `json:"enabled,omitempty"`
		Status  string `json:"status,omitempty"`
	}
	cog := cognitoInfo{}
	if h.cognitoAdmin != nil {
		exists, enabled, status, cerr := h.cognitoAdmin.GetUserStatus(ctx, person.Email)
		if cerr != nil {
			h.log.Warn().Err(cerr).Str("email", person.Email).Msg("admin user: cognito status")
		} else {
			cog.Exists = &exists
			cog.Enabled = enabled
			cog.Status = status
		}
	}

	affs, err := h.store.ListPersonAffiliates(ctx, person.ID)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user: affiliates")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	wallets, err := h.store.ListPersonWallets(ctx, person.ID)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user: wallets")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	active, total, err := h.store.PersonPackageCounts(ctx, person.ID)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user: packages")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	movements := []AdminUserMovement{}
	var branch *AdminUserBranch
	if len(affs) > 0 {
		principal := affs[0] // primer afiliado colocado (person_id es UNIQUE: 0 o 1)
		movements, err = h.store.RecentAffiliateMovements(ctx, principal.ID, 15)
		if err != nil {
			h.log.Error().Err(err).Msg("admin user: movements")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		b := AdminUserBranch{
			AffiliateID:    principal.ID,
			DownlineTotal:  principal.leftCount + principal.rightCount,
			DownlineLeft:   principal.leftCount,
			DownlineRight:  principal.rightCount,
			PVLeft:         principal.leftPV,
			PVRight:        principal.rightPV,
			SalesUSD:       "0",
			CommissionsUSD: "0",
		}
		if b.DownlineTotal > maxBranchAggDownline {
			b.AggSkipped = true // rama enorme: no barremos el ledger completo online
		} else {
			sales, comm, merr := h.store.BranchMoney(ctx, principal.ID)
			if merr != nil {
				h.log.Error().Err(merr).Int64("affiliate_id", principal.ID).Msg("admin user: branch money")
				writeErr(w, http.StatusInternalServerError, "internal")
				return
			}
			b.SalesUSD, b.CommissionsUSD = sales, comm
		}
		branch = &b
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"person":           person,
		"cognito":          cog,
		"affiliates":       affs,
		"wallets":          wallets,
		"recent_movements": movements,
		"packages":         map[string]int{"active": active, "total": total},
		"branch":           branch,
	})
}

type adminUserUpdateReq struct {
	Email     string  `json:"email"` // identidad del admin solicitante (fallback sin id token)
	PersonID  int64   `json:"person_id"`
	FirstName *string `json:"first_name"`
	LastName  *string `json:"last_name"`
	NewEmail  *string `json:"new_email"`
	// El contrato del front manda el email nuevo como "email" chocaría con la
	// identidad; se acepta también "user_email" por compat.
	UserEmail *string `json:"user_email"`
	Phone     *string `json:"phone"`
	// "address" NO se acepta: mlm.person no tiene columna de dirección.
}

// normPtr recorta espacios; un valor presente pero vacío se trata como ausente.
func normPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

// handleAdminUserUpdate: PUT /api/admin/user — editar identidad. Solo actualiza
// los campos presentes. Cambiar el email en DB sincroniza purchase_intent por
// person_id, pero NO cambia el usuario de acceso en Cognito: se devuelve
// cognito_note para que el front lo muestre.
func (h *Handler) handleAdminUserUpdate(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	var req adminUserUpdateReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	_, caller, ok := h.effectiveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if admin, err := h.isAdminEmail(r.Context(), caller); err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	if req.PersonID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing_person_id")
		return
	}

	firstName := normPtr(req.FirstName)
	lastName := normPtr(req.LastName)
	newEmail := normPtr(req.NewEmail)
	if newEmail == nil {
		newEmail = normPtr(req.UserEmail)
	}
	phone := normPtr(req.Phone)
	if firstName == nil && lastName == nil && newEmail == nil && phone == nil {
		writeErr(w, http.StatusBadRequest, "no_fields")
		return
	}

	if newEmail != nil {
		if !emailFmtRe.MatchString(*newEmail) {
			writeErr(w, http.StatusBadRequest, "invalid_email")
			return
		}
		taken, err := h.store.EmailTakenByOther(r.Context(), *newEmail, req.PersonID)
		if err != nil {
			h.log.Error().Err(err).Msg("admin user update: email taken check")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		if taken {
			writeErr(w, http.StatusConflict, "email_taken")
			return
		}
	}

	// Email previo (para invalidar el cache de contexto de miembro y auditar).
	prev, found, err := h.store.GetAdminUserPerson(r.Context(), req.PersonID, "")
	if err != nil {
		h.log.Error().Err(err).Msg("admin user update: prev lookup")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}

	n, paymentRows, err := h.store.UpdatePersonIdentity(r.Context(), req.PersonID, firstName, lastName, newEmail, phone)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user update")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if n == 0 {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}

	// El nombre/código cacheados del miembro quedan viejos tras la edición.
	h.store.invalidateMemberCaches(r.Context(), prev.Email)
	if newEmail != nil {
		h.store.invalidateMemberCaches(r.Context(), *newEmail)
	}

	changed := []string{}
	for f, p := range map[string]*string{
		"first_name": firstName, "last_name": lastName, "email": newEmail, "phone": phone,
	} {
		if p != nil {
			changed = append(changed, f)
		}
	}
	// AUDIT: quién cambió qué campos de qué persona.
	h.log.Info().Str("by", caller).Int64("person_id", req.PersonID).
		Strs("fields", changed).Str("prev_email", prev.Email).
		Msg("admin user: identidad editada")

	resp := map[string]any{"ok": true, "person_id": req.PersonID, "updated_fields": changed}
	if newEmail != nil {
		resp["payment_user_ids_updated"] = paymentRows
		resp["cognito_note"] = "el email de acceso (Cognito) no cambia automáticamente"
	}
	writeJSON(w, http.StatusOK, resp)
}

type adminUserDeleteReq struct {
	Email    string `json:"email"` // identidad del admin solicitante (fallback sin id token)
	PersonID int64  `json:"person_id"`
	Confirm  string `json:"confirm"` // debe ser exactamente "DELETE"
}

// handleAdminUserDelete: DELETE /api/admin/user — soft-delete (solo
// super_admin). Rehúsa si hay saldo en wallet o paquete activo (has_balance) o
// si el objetivo es admin. Deshabilita el login en Cognito (best-effort, patrón
// del ban). El nodo queda inerte en su lugar: no se toca parent_id ni closure.
func (h *Handler) handleAdminUserDelete(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	var req adminUserDeleteReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	_, caller, ok := h.effectiveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if !h.isSuperAdmin(caller) {
		writeErr(w, http.StatusForbidden, "not_super_admin")
		return
	}
	if req.PersonID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing_person_id")
		return
	}
	if req.Confirm != "DELETE" {
		writeErr(w, http.StatusBadRequest, "confirm_required")
		return
	}

	ctx := r.Context()
	person, found, err := h.store.GetAdminUserPerson(ctx, req.PersonID, "")
	if err != nil {
		h.log.Error().Err(err).Msg("admin user delete: lookup")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	// Nunca borrar administradores (flag is_admin o allowlist por env).
	if targetAdmin, aerr := h.isAdminEmail(ctx, person.Email); aerr != nil {
		h.log.Error().Err(aerr).Msg("admin user delete: is_admin check")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	} else if targetAdmin || person.IsAdmin {
		writeErr(w, http.StatusForbidden, "target_is_admin")
		return
	}
	hasBalance, hasActivePkg, err := h.store.PersonDeleteGuards(ctx, req.PersonID)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user delete: guards")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if hasBalance || hasActivePkg {
		// Wallet con saldo o paquete activo ⇒ requiere decisión humana explícita.
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":              "has_balance",
			"has_balance":        hasBalance,
			"has_active_package": hasActivePkg,
		})
		return
	}

	if err := h.store.SoftDeletePerson(ctx, req.PersonID); err != nil {
		h.log.Error().Err(err).Msg("admin user delete")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Cognito: deshabilitar login (best-effort, mismo patrón que el ban).
	cognitoDisabled := false
	if h.cognitoAdmin != nil {
		if applied, cerr := h.cognitoAdmin.SetEnabled(ctx, person.Email, false); cerr != nil {
			h.log.Error().Err(cerr).Str("email", person.Email).Msg("admin user delete: cognito disable")
		} else {
			cognitoDisabled = applied
		}
	}
	h.store.cache.del(ctx, "refctx:"+strings.ToLower(strings.TrimSpace(person.Email)))

	// AUDIT: quién borró a quién.
	h.log.Info().Str("by", caller).Int64("person_id", req.PersonID).
		Str("target_email", person.Email).Bool("cognito_disabled", cognitoDisabled).
		Msg("admin user: soft-delete aplicado")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "person_id": req.PersonID, "status": "deleted",
		"cognito_disabled": cognitoDisabled,
	})
}

// ── Branch tree (mini resumen del subárbol) ─────────────────────────────────

// AdminBranchNode es un nodo del mini resumen (root o hijo directo).
type AdminBranchNode struct {
	ID            int64   `json:"id"`
	Handle        string  `json:"handle"`
	Side          *string `json:"side"` // "L" | "R" | null (root del subárbol)
	Status        string  `json:"status"`
	DownlineTotal int64   `json:"downline_total"`
	DownlineLeft  int64   `json:"downline_left,omitempty"`
	DownlineRight int64   `json:"downline_right,omitempty"`
}

// GetBranchMini devuelve el nodo raíz y sus hijos directos L/R con conteos
// denormalizados (para que el front pinte el resumen sin duplicar la Red).
func (s *Store) GetBranchMini(ctx context.Context, affiliateID int64) (*AdminBranchNode, []AdminBranchNode, error) {
	var root AdminBranchNode
	err := s.reader().QueryRow(ctx, `
		SELECT a.id, COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       a.position::text, a.status::text,
		       a.left_count + a.right_count, a.left_count, a.right_count
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id
		 WHERE a.id = $1
		   AND a.status::text NOT IN ('deleted','suspended','banned')
		   AND p.status::text NOT IN ('deleted','suspended','banned')
		   AND NOT COALESCE(p.blacklisted,false)
		   AND NOT EXISTS (
		     SELECT 1
		       FROM mlm.blacklist b
		      WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		         OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		         OR (b.name_norm IS NOT NULL
		             AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		             AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		   )
	`, affiliateID).Scan(&root.ID, &root.Handle, &root.Side, &root.Status,
		&root.DownlineTotal, &root.DownlineLeft, &root.DownlineRight)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("branch mini root: %w", err)
	}

	rows, err := s.reader().Query(ctx, `
		SELECT a.id, COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       a.position::text, a.status::text, a.left_count + a.right_count
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id
		 WHERE a.parent_id = $1
		   AND a.status::text NOT IN ('deleted','suspended','banned')
		   AND p.status::text NOT IN ('deleted','suspended','banned')
		   AND NOT COALESCE(p.blacklisted,false)
		   AND NOT EXISTS (
		     SELECT 1
		       FROM mlm.blacklist b
		      WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		         OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		         OR (b.name_norm IS NOT NULL
		             AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		             AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		   )
		 ORDER BY a.position
	`, affiliateID)
	if err != nil {
		return nil, nil, fmt.Errorf("branch mini children: %w", err)
	}
	defer rows.Close()
	children := []AdminBranchNode{}
	for rows.Next() {
		var c AdminBranchNode
		if err := rows.Scan(&c.ID, &c.Handle, &c.Side, &c.Status, &c.DownlineTotal); err != nil {
			return nil, nil, fmt.Errorf("scan branch child: %w", err)
		}
		children = append(children, c)
	}
	return &root, children, rows.Err()
}

// handleAdminUserBranchTree: GET /api/admin/user/branch-tree?affiliate_id=N —
// hijos directos L/R con conteos, para el resumen del inspector.
func (h *Handler) handleAdminUserBranchTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	affiliateID, _ := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("affiliate_id")), 10, 64)
	if affiliateID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing_affiliate_id")
		return
	}
	root, children, err := h.store.GetBranchMini(r.Context(), affiliateID)
	if err != nil {
		h.log.Error().Err(err).Msg("admin user: branch tree")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if root == nil {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root": root, "children": children})
}
