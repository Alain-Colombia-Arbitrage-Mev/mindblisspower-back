package payments

// This is a display-only read model. Importing a source fact must never replay
// checkout activation, financial compensation, identity binding or tree writes.
import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const consolidatedSalesSource = "consolidated_sales_v1"

type SalesSourceSummary struct {
	Provider                 string  `json:"provider"`
	Sales                    int64   `json:"sales"`
	GrossUSD                 string  `json:"gross_usd"`
	RefundedUSD              string  `json:"refunded_usd"`
	ProcessingFeeUSD         string  `json:"processing_fee_usd"`
	VerifiedProcessingFeeUSD *string `json:"verified_processing_fee_usd"`
	NetUSD                   string  `json:"net_usd"`
	PaidSales                int64   `json:"paid_sales"`
	PaidGrossUSD             string  `json:"paid_gross_usd"`
	ReviewSales              int64   `json:"review_sales"`
	ReviewGrossUSD           string  `json:"review_gross_usd"`
	ActivatedSales           int64   `json:"activated_sales"`
	DisputedSales            int64   `json:"disputed_sales"`
	RiskSales                int64   `json:"risk_sales"`
	RefundedSales            int64   `json:"refunded_sales"`
}

type SalesImportBatch struct {
	ID         string          `json:"id"`
	SHA256     string          `json:"sha256"`
	ImportedAt string          `json:"imported_at"`
	Rows       int64           `json:"rows"`
	Scope      string          `json:"scope"`
	Statement  json.RawMessage `json:"statement"`
	Controls   json.RawMessage `json:"controls"`
}

type AdminSalesSummary struct {
	DataSource string `json:"data_source"`
	Currency   string `json:"currency"`
	Scope      string `json:"scope"`
	From       string `json:"from,omitempty"`
	SalesSourceSummary
	Sources     []SalesSourceSummary `json:"sources"`
	ImportBatch *SalesImportBatch    `json:"import_batch"`
}

type adminSalesFilterKey struct{}
type adminSalesFilter struct{ provider string }

func salesProvider(ctx context.Context) string {
	filter, _ := ctx.Value(adminSalesFilterKey{}).(adminSalesFilter)
	return filter.provider
}

// Only these exact selectors are accepted; malformed input must not silently
// remove a provider/date filter and produce a different financial report.
func adminSalesRequest(r *http.Request) (*http.Request, time.Time, int, error) {
	q := r.URL.Query()
	for _, key := range []string{"provider", "scope", "days"} {
		if len(q[key]) > 1 {
			return r, time.Time{}, 0, fmt.Errorf("duplicate sales filter")
		}
	}
	provider := q.Get("provider")
	if provider != "" && provider != "stripe" && provider != "nowpayments" {
		return r, time.Time{}, 0, fmt.Errorf("invalid provider")
	}
	scope := q.Get("scope")
	if scope != "" && scope != "all" {
		return r, time.Time{}, 0, fmt.Errorf("invalid scope")
	}
	days := 30
	if raw, supplied := q["days"]; supplied {
		if len(raw[0]) < 1 || len(raw[0]) > 3 {
			return r, time.Time{}, 0, fmt.Errorf("invalid days")
		}
		for _, digit := range raw[0] {
			if digit < '0' || digit > '9' {
				return r, time.Time{}, 0, fmt.Errorf("invalid days")
			}
		}
		parsed, err := strconv.Atoi(raw[0])
		if err != nil {
			return r, time.Time{}, 0, fmt.Errorf("invalid days")
		}
		days = parsed
	}
	if days < 1 || days > 365 {
		return r, time.Time{}, 0, fmt.Errorf("invalid days")
	}
	from := time.Now().UTC().AddDate(0, 0, -days)
	if scope == "all" {
		from, days = time.Time{}, 0
	}
	return r.WithContext(context.WithValue(r.Context(), adminSalesFilterKey{}, adminSalesFilter{provider})), from, days, nil
}

func (s *Store) hasAdminSales(ctx context.Context) (bool, error) {
	var present bool
	err := s.db.QueryRow(ctx, `SELECT to_regclass('payments.v_admin_sales') IS NOT NULL`).Scan(&present)
	if err != nil {
		return false, fmt.Errorf("detect consolidated sales: %w", err)
	}
	return present, nil
}

const adminSalesWhere = ` WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2='' OR provider=$2)`
const adminSalesPaid = `lower(btrim(source_status)) IN ('paid','finished','pagado')`
const adminSalesReview = `lower(btrim(source_status)) IN ('under_review','under review','en revisión','en revision')`
const adminSalesAggregate = `count(*),
 (COALESCE(sum(gross_minor),0)::numeric/100)::numeric(24,2)::text,
 (COALESCE(sum(refunded_minor),0)::numeric/100)::numeric(24,2)::text,
 (COALESCE(sum(fee_minor),0)::numeric/100)::numeric(24,2)::text,
 CASE WHEN count(*) FILTER(WHERE verified_fee_minor IS NULL)=0 THEN (COALESCE(sum(verified_fee_minor),0)::numeric/100)::numeric(24,2)::text END,
 (COALESCE(sum(net_minor),0)::numeric/100)::numeric(24,2)::text,
 count(*) FILTER(WHERE ` + adminSalesPaid + `),
 (COALESCE(sum(gross_minor) FILTER(WHERE ` + adminSalesPaid + `),0)::numeric/100)::numeric(24,2)::text,
 count(*) FILTER(WHERE ` + adminSalesReview + `),
 (COALESCE(sum(gross_minor) FILTER(WHERE ` + adminSalesReview + `),0)::numeric/100)::numeric(24,2)::text,
 count(*) FILTER(WHERE activation_status='activated'),
 count(*) FILTER(WHERE risk_status='disputed'),
 count(*) FILTER(WHERE risk_status<>'none'),count(*) FILTER(WHERE refunded_minor>0)`

func salesFrom(from time.Time) any {
	if from.IsZero() {
		return nil
	}
	return from
}

func scanSalesAggregate(row interface{ Scan(...any) error }, out *SalesSourceSummary, prefix ...any) error {
	return row.Scan(append(prefix, &out.Sales, &out.GrossUSD, &out.RefundedUSD, &out.ProcessingFeeUSD,
		&out.VerifiedProcessingFeeUSD, &out.NetUSD, &out.PaidSales, &out.PaidGrossUSD,
		&out.ReviewSales, &out.ReviewGrossUSD, &out.ActivatedSales, &out.DisputedSales, &out.RiskSales, &out.RefundedSales)...)
}

func (s *Store) adminSalesSummary(ctx context.Context, from time.Time) (*AdminSalesSummary, error) {
	out := &AdminSalesSummary{DataSource: consolidatedSalesSource, Currency: "usd", Scope: "all_time", Sources: []SalesSourceSummary{}}
	if !from.IsZero() {
		out.Scope, out.From = "period", from.UTC().Format(time.RFC3339)
	}
	// Sources, aggregate and active import metadata share ONE statement/MVCC
	// snapshot. A newly completed NOW payment or import pointer switch cannot
	// produce an aggregate that disagrees with its provider breakdown or batch.
	rows, err := s.db.Query(ctx, `WITH grouped AS (
 SELECT COALESCE(provider,'') AS provider,`+adminSalesAggregate+`
 FROM payments.v_admin_sales`+adminSalesWhere+` GROUP BY GROUPING SETS((provider),())
 ) SELECT grouped.*,b.id::text,b.file_sha256,b.imported_at,b.row_count,b.statement,b.controls
 FROM grouped CROSS JOIN payments.v_admin_sales_source source
 JOIN payments.v_admin_sales_import_batch b ON b.id=source.active_batch_id
 WHERE source.provider='stripe' ORDER BY grouped.provider`, salesFrom(from), salesProvider(ctx))
	if err != nil {
		return nil, fmt.Errorf("consolidated sales sources: %w", err)
	}
	defer rows.Close()
	foundTotal := false
	for rows.Next() {
		var source SalesSourceSummary
		var batch SalesImportBatch
		var imported time.Time
		args := []any{&source.Provider, &source.Sales, &source.GrossUSD, &source.RefundedUSD, &source.ProcessingFeeUSD,
			&source.VerifiedProcessingFeeUSD, &source.NetUSD, &source.PaidSales, &source.PaidGrossUSD,
			&source.ReviewSales, &source.ReviewGrossUSD, &source.ActivatedSales, &source.DisputedSales, &source.RiskSales, &source.RefundedSales,
			&batch.ID, &batch.SHA256, &imported, &batch.Rows, &batch.Statement, &batch.Controls}
		if err := rows.Scan(args...); err != nil {
			return nil, err
		}
		if source.Provider == "" {
			out.SalesSourceSummary, foundTotal = source, true
			out.Provider = salesProvider(ctx)
			// This snapshot is all-time owner/source evidence, never prorated to
			// the requested sales period or treated as bank settlement proof.
			batch.ImportedAt, batch.Scope = imported.UTC().Format(time.RFC3339Nano), "all_time_import_snapshot"
			out.ImportBatch = &batch
		} else {
			out.Sources = append(out.Sources, source)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !foundTotal {
		return nil, fmt.Errorf("active reviewed sales import evidence is missing")
	}
	return out, nil
}

func (s *Store) adminSalesReport(ctx context.Context, from time.Time) ([]SalesRow, error) {
	rows, err := s.db.Query(ctx, `SELECT provider,COALESCE(package_id,0),package_name,
 COALESCE((base_minor::numeric/100)::numeric(24,2)::text,''),count(*),
 count(*) FILTER(WHERE `+adminSalesPaid+`),count(*) FILTER(WHERE activation_status='activated'),
 CASE WHEN count(*) FILTER(WHERE base_minor IS NULL)=0 THEN (sum(base_minor)::numeric/100)::numeric(24,2)::text ELSE '' END,
 (sum(gross_minor)::numeric/100)::numeric(24,2)::text,(sum(refunded_minor)::numeric/100)::numeric(24,2)::text,
 count(*) FILTER(WHERE `+adminSalesReview+`),(sum(fee_minor)::numeric/100)::numeric(24,2)::text,(sum(net_minor)::numeric/100)::numeric(24,2)::text
 FROM payments.v_admin_sales`+adminSalesWhere+` GROUP BY provider,package_id,package_name,base_minor ORDER BY base_minor NULLS LAST,provider,package_id`, salesFrom(from), salesProvider(ctx))
	if err != nil {
		return nil, fmt.Errorf("consolidated sales report: %w", err)
	}
	defer rows.Close()
	out := []SalesRow{}
	for rows.Next() {
		r := SalesRow{DataSource: consolidatedSalesSource}
		if err := rows.Scan(&r.Provider, &r.PackageID, &r.Name, &r.AmountUSD, &r.Created, &r.Paid, &r.Activated, &r.RevenueUSD, &r.GrossUSD, &r.RefundedUSD, &r.ReviewSales, &r.ProcessingFeeUSD, &r.NetUSD); err != nil {
			return nil, err
		}
		r.Sales = r.Created
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) adminSalesTransactions(ctx context.Context, from time.Time, status, q string, limit, offset int) ([]SalesTransaction, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	filter := adminSalesWhere + ` AND ($3='' OR display_status=$3 OR ($3='activated' AND activation_status='activated')
 OR ($3='disputed' AND risk_status='disputed') OR ($3='refunded' AND (refunded_minor>0 OR risk_status='refunded'))
 OR ($3='security_blocked' AND risk_status='security_blocked'))
 AND ($4='' OR buyer_email ILIKE '%'||$4||'%' OR buyer_name ILIKE '%'||$4||'%' OR provider_reference ILIKE '%'||$4||'%' OR external_id ILIKE '%'||$4||'%')`
	var total int64
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM payments.v_admin_sales`+filter, salesFrom(from), salesProvider(ctx), status, q).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, `SELECT provider,external_id,provider_reference,created_at,paid_at,buyer_email,buyer_name,package_name,
 COALESCE((base_minor::numeric/100)::numeric(24,2)::text,''),
 CASE WHEN base_minor IS NOT NULL THEN ((gross_minor-base_minor)::numeric/100)::numeric(24,2)::text ELSE '' END,
 (gross_minor::numeric/100)::numeric(24,2)::text,display_status,affiliate_id,
 (refunded_minor::numeric/100)::numeric(24,2)::text,source_status,activation_status,risk_status,
 (fee_minor::numeric/100)::numeric(24,2)::text,(net_minor::numeric/100)::numeric(24,2)::text,
 CASE WHEN verified_fee_minor IS NOT NULL THEN (verified_fee_minor::numeric/100)::numeric(24,2)::text END,
 product_scope,commission_eligible,provider_verified,fee_reconciliation_status
 FROM payments.v_admin_sales`+filter+` ORDER BY created_at DESC,provider,external_id LIMIT $5 OFFSET $6`, salesFrom(from), salesProvider(ctx), status, q, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []SalesTransaction{}
	for rows.Next() {
		r := SalesTransaction{DataSource: consolidatedSalesSource, ReadOnly: true, CommissionStatus: "not_inferred_from_sales_report"}
		var external string
		var created time.Time
		var paid *time.Time
		if err := rows.Scan(&r.Provider, &external, &r.Reference, &created, &paid, &r.Email, &r.Name, &r.Plan,
			&r.AmountUSD, &r.FeeUSD, &r.TotalUSD, &r.Status, &r.AffiliateID, &r.RefundUSD,
			&r.SourceStatus, &r.ActivationStatus, &r.RiskStatus, &r.ProcessingFeeUSD, &r.NetUSD, &r.VerifiedProcessingFeeUSD,
			&r.ProductScope, &r.CommissionEligible, &r.ProviderVerified, &r.FeeReconciliationStatus); err != nil {
			return nil, 0, err
		}
		r.ID, r.CreatedAt = r.Provider+":"+external, created.UTC().Format(time.RFC3339Nano)
		if paid != nil {
			r.PaidAt = paid.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

func (s *Store) adminSalesFinance(ctx context.Context) (AdminFinance, error) {
	summary, err := s.adminSalesSummary(ctx, time.Time{})
	if err != nil {
		return AdminFinance{}, err
	}
	out := AdminFinance{DataSource: consolidatedSalesSource, SalesSummary: summary,
		InflowsUSD: summary.GrossUSD, PacksPaid: summary.PaidSales, RefundedUSD: summary.RefundedUSD, RefundedPayments: summary.RefundedSales, Moneyflow: []MoneyflowRow{}}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_rank_achieved`).Scan(&out.RanksAchieved); err != nil {
		return out, err
	}
	return out, nil
}

func adminSalesUsersSQL() string {
	return adminUsersReadSQLWithPaid(`COALESCE((SELECT sum(s.gross_minor)::numeric/100 FROM payments.v_admin_sales s WHERE s.person_id=p.id),0)::numeric(24,2)::text`)
}

func salesSummarySource(summary *AdminSalesSummary) string {
	if summary == nil {
		return ""
	}
	return summary.DataSource
}

func (p AdminPayment) MarshalJSON() ([]byte, error) {
	type wire AdminPayment
	if p.DataSource != consolidatedSalesSource {
		return json.Marshal(wire(p))
	}
	fields := []string{"refunded_at", "refund_cents", "stripe_refund_id", "refund_reason", "package_id"}
	if p.AmountUSD == "" {
		fields = append(fields, "amount_usd", "fee_usd")
	}
	return recoveryNullFields(wire(p), fields...)
}
