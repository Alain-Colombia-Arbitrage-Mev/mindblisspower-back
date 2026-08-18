package payments

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxUsersExportQueryLen = 160

type AdminUserExportRow struct {
	PersonID          int64
	FirstName         string
	LastName          string
	Name              string
	Alias             string
	Email             string
	PhoneCountry      string
	Phone             string
	Country           string
	PayoutWalletUSDC  string
	Status            string
	Active            bool
	Blacklisted       bool
	KYCStatus         string
	AffiliateID       *int64
	AffiliateCode     string
	NetworkPosition   string
	ParentAffiliateID *int64
	SponsorID         *int64
	SponsorName       string
	SponsorEmail      string
	Rank              string
	LeftCount         int64
	RightCount        int64
	ActivePackages    int
	OwnPurchasesUSD   string
	TotalSalesUSD     string
}

func normalizeUsersExportStatusFilter(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "all", "todos", "todas":
		return "", true
	case "active", "activo", "activos":
		return "active", true
	case "inactive", "inactivo", "inactivos":
		return "inactive", true
	default:
		return "", false
	}
}

func normalizeUsersExportQuery(value string) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) <= maxUsersExportQueryLen {
		return value
	}
	return string([]rune(value)[:maxUsersExportQueryLen])
}

func (s *Store) ExportUsers(ctx context.Context, q, status string) ([]AdminUserExportRow, error) {
	q = normalizeUsersExportQuery(q)
	status, ok := normalizeUsersExportStatusFilter(status)
	if !ok {
		return nil, fmt.Errorf("invalid status filter")
	}

	rows, err := s.reader().Query(ctx, `
		WITH own_purchases AS (
			SELECT lower(pi.user_id) AS email,
			       COALESCE(SUM(pi.amount_usd + pi.fee_usd), 0)::text AS total_usd
			  FROM payments.purchase_intent pi
			 WHERE pi.paid_at IS NOT NULL
			   AND pi.status NOT IN ('refunded','security_blocked','disputed','chargeback')
			   AND pi.stripe_present IS DISTINCT FROM false
			 GROUP BY lower(pi.user_id)
		),
		direct_sales AS (
			SELECT pi.sponsor_affiliate_id AS affiliate_id,
			       COALESCE(SUM(pi.amount_usd + pi.fee_usd), 0)::text AS total_usd
			  FROM payments.purchase_intent pi
			 WHERE pi.sponsor_affiliate_id IS NOT NULL
			   AND pi.paid_at IS NOT NULL
			   AND pi.status NOT IN ('refunded','security_blocked','disputed','chargeback')
			   AND pi.stripe_present IS DISTINCT FROM false
			 GROUP BY pi.sponsor_affiliate_id
		)
		SELECT p.id,
		       COALESCE(p.first_name, ''),
		       COALESCE(p.last_name, ''),
		       trim(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS name,
		       COALESCE(p.alias, ''),
		       p.email::text,
		       COALESCE(pc.phone_code, ''),
		       COALESCE(p.phone_number, ''),
		       COALESCE(p.country, ''),
		       COALESCE(p.payout_wallet_usdc, ''),
		       p.status::text,
		       (p.status = 'active' AND NOT COALESCE(p.blacklisted, false)) AS active,
		       COALESCE(p.blacklisted, false),
		       p.kyc_status::text,
		       a.id,
		       COALESCE(NULLIF(a.invitation_link, ''), CASE WHEN a.id IS NULL THEN '' ELSE 'MP' || a.id::text END),
		       COALESCE(a.position::text, CASE WHEN a.id IS NULL THEN 'sin posicion' ELSE 'root' END),
		       a.parent_id,
		       a.sponsor_id,
		       trim(COALESCE(sp.first_name, '') || ' ' || COALESCE(sp.last_name, '')) AS sponsor_name,
		       COALESCE(sp.email::text, ''),
		       COALESCE(r.name_es, ''),
		       COALESCE(a.left_count, 0),
		       COALESCE(a.right_count, 0),
		       COALESCE((
		         SELECT count(*) FROM mlm.affiliate_package ap
		          WHERE ap.affiliate_id = a.id AND ap.status = 'active'
		       ), 0),
		       COALESCE(op.total_usd, '0'),
		       COALESCE(ds.total_usd, '0')
		  FROM mlm.person p
		  LEFT JOIN mlm.country pc   ON pc.id = p.phone_country_id
		  LEFT JOIN mlm.affiliate a  ON a.person_id = p.id
		  LEFT JOIN mlm.affiliate sa ON sa.id = a.sponsor_id
		  LEFT JOIN mlm.person sp    ON sp.id = sa.person_id
		  LEFT JOIN mlm.rank r       ON r.id = a.current_rank_id
		  LEFT JOIN own_purchases op ON op.email = lower(p.email::text)
		  LEFT JOIN direct_sales ds  ON ds.affiliate_id = a.id
		 WHERE ($1 = ''
		        OR p.email ILIKE '%' || $1 || '%'
		        OR (COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) ILIKE '%' || $1 || '%'
		        OR COALESCE(p.phone_number, '') ILIKE '%' || $1 || '%')
		   AND ($2 = ''
		        OR ($2 = 'active' AND p.status = 'active' AND NOT COALESCE(p.blacklisted, false))
		        OR ($2 = 'inactive' AND (p.status <> 'active' OR COALESCE(p.blacklisted, false))))
		 ORDER BY p.id DESC
	`, q, status)
	if err != nil {
		return nil, fmt.Errorf("export users: %w", err)
	}
	defer rows.Close()

	out := []AdminUserExportRow{}
	for rows.Next() {
		var r AdminUserExportRow
		if err := rows.Scan(
			&r.PersonID, &r.FirstName, &r.LastName, &r.Name, &r.Alias, &r.Email,
			&r.PhoneCountry, &r.Phone, &r.Country, &r.PayoutWalletUSDC,
			&r.Status, &r.Active, &r.Blacklisted, &r.KYCStatus,
			&r.AffiliateID, &r.AffiliateCode, &r.NetworkPosition,
			&r.ParentAffiliateID, &r.SponsorID, &r.SponsorName, &r.SponsorEmail,
			&r.Rank, &r.LeftCount, &r.RightCount, &r.ActivePackages,
			&r.OwnPurchasesUSD, &r.TotalSalesUSD,
		); err != nil {
			return nil, fmt.Errorf("scan export user: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func adminUsersCSV(rows []AdminUserExportRow) ([]byte, error) {
	buf := bytes.NewBuffer(nil)
	buf.Write([]byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM for Excel.
	w := csv.NewWriter(buf)
	if err := w.Write([]string{
		"person_id",
		"nombre",
		"primer_nombre",
		"apellido",
		"alias",
		"correo",
		"codigo_pais_telefono",
		"telefono",
		"pais",
		"wallet_usdc",
		"estado",
		"activo",
		"bloqueado",
		"kyc",
		"affiliate_id",
		"codigo_afiliado",
		"posicion_red",
		"parent_affiliate_id",
		"sponsor_affiliate_id",
		"sponsor_nombre",
		"sponsor_correo",
		"rango",
		"izquierda_count",
		"derecha_count",
		"paquetes_activos",
		"compras_propias_usd",
		"monto_total_ventas_usd",
	}); err != nil {
		return nil, err
	}
	for _, r := range rows {
		if err := w.Write([]string{
			strconv.FormatInt(r.PersonID, 10),
			csvSafeCell(r.Name),
			csvSafeCell(r.FirstName),
			csvSafeCell(r.LastName),
			csvSafeCell(r.Alias),
			csvSafeCell(r.Email),
			csvSafeCell(r.PhoneCountry),
			csvSafeCell(r.Phone),
			csvSafeCell(r.Country),
			csvSafeCell(r.PayoutWalletUSDC),
			csvSafeCell(r.Status),
			boolCSV(r.Active),
			boolCSV(r.Blacklisted),
			csvSafeCell(r.KYCStatus),
			int64PtrCSV(r.AffiliateID),
			csvSafeCell(r.AffiliateCode),
			csvSafeCell(r.NetworkPosition),
			int64PtrCSV(r.ParentAffiliateID),
			int64PtrCSV(r.SponsorID),
			csvSafeCell(r.SponsorName),
			csvSafeCell(r.SponsorEmail),
			csvSafeCell(r.Rank),
			strconv.FormatInt(r.LeftCount, 10),
			strconv.FormatInt(r.RightCount, 10),
			strconv.Itoa(r.ActivePackages),
			decimalCSV(r.OwnPurchasesUSD),
			decimalCSV(r.TotalSalesUSD),
		}); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func boolCSV(value bool) string {
	if value {
		return "si"
	}
	return "no"
}

func int64PtrCSV(value *int64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatInt(*value, 10)
}

func decimalCSV(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "0"
	}
	return value
}

func csvSafeCell(value string) string {
	value = strings.ReplaceAll(value, "\x00", "")
	probe := strings.TrimLeft(value, " \t\r\n")
	if probe == "" {
		return value
	}
	switch probe[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}

func (h *Handler) handleAdminUsersExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	caller, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	status, valid := normalizeUsersExportStatusFilter(r.URL.Query().Get("status"))
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid_status")
		return
	}
	q := normalizeUsersExportQuery(r.URL.Query().Get("q"))
	rows, err := h.store.ExportUsers(r.Context(), q, status)
	if err != nil {
		h.log.Error().Err(err).Msg("export users")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	body, err := adminUsersCSV(rows)
	if err != nil {
		h.log.Error().Err(err).Msg("export users csv")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	filterLabel := status
	if filterLabel == "" {
		filterLabel = "todos"
	}
	filename := fmt.Sprintf("mindbliss-usuarios-%s-%s.csv", filterLabel, time.Now().UTC().Format("20060102"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	h.log.Info().Str("by", caller).Str("status", filterLabel).Int("rows", len(rows)).Msg("admin users exported")
}
