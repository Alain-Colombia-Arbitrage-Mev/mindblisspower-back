// Package manualmembership is an operator-only, source-separated activation
// capability. It has no HTTP handler, provider client, OTP sender or scheduler.
package manualmembership

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/membershipsource"
	"github.com/vicionpower/vp-engine/internal/nowengine"
)

var (
	ErrInvalidInput  = errors.New("invalid authorized manual membership input")
	ErrUnavailable   = errors.New("manual membership activation unavailable")
	ErrTarget        = errors.New("manual membership target requires review")
	ErrConflict      = errors.New("manual membership operation conflicts with existing evidence")
	ErrStateDrift    = errors.New("manual membership state changed")
	ErrCommitUnknown = errors.New("manual membership commit outcome requires read-only verification")

	operationKey = regexp.MustCompile(`^manual-membership:[a-z0-9][a-z0-9._:-]{7,111}$`)
	hexDigest    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	databaseName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,62}$`)
)

// Input identifies one reviewed owner instruction and one existing position.
// The authorization digest is an audit reference, not a cryptographic grant.
// Only a separately privileged local operator may invoke this capability.
// Effective/approval/start times are deliberately NOT caller supplied.
type Input struct {
	ExpectedDatabase        string `json:"expected_database"`
	ID                      string `json:"id"`
	OperationKey            string `json:"operation_key"`
	PersonID                int64  `json:"person_id"`
	AffiliateID             int64  `json:"affiliate_id"`
	PersonPublicID          string `json:"person_public_id"`
	PackageID               int    `json:"package_id"`
	AuthorizationDigest     string `json:"authorization_digest"`
	ActorReason             string `json:"actor_reason"`
	Authority               string `json:"authority"`
	ExpectedAffiliateSHA256 string `json:"expected_affiliate_sha256"`
}

type Result struct {
	ID                       string
	AffiliatePackageID, CDID int64
	EffectiveAt, MaturesAt   time.Time
	Replay                   bool
}

type Service struct {
	root  int64
	begin func(context.Context, pgx.TxOptions) (pgx.Tx, error)
	ready func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool, companyRoot int64) *Service {
	s := &Service{root: companyRoot}
	if pool != nil {
		s.begin = pool.BeginTx
		s.ready = nowengine.New(pool, companyRoot).ValidateReady
	}
	return s
}

func validateInput(in Input) error {
	id, err := uuid.Parse(in.ID)
	if err != nil || id.Version() != 4 || id.String() != in.ID {
		return ErrInvalidInput
	}
	publicID, err := uuid.Parse(in.PersonPublicID)
	if err != nil || publicID == uuid.Nil || publicID.String() != in.PersonPublicID ||
		!databaseName.MatchString(in.ExpectedDatabase) || !operationKey.MatchString(in.OperationKey) ||
		in.PersonID <= 0 || in.AffiliateID <= 0 || in.PackageID <= 0 || in.Authority != "owner_instruction" ||
		!hexDigest.MatchString(in.AuthorizationDigest) || in.AuthorizationDigest == strings.Repeat("0", 64) ||
		!hexDigest.MatchString(in.ExpectedAffiliateSHA256) || !utf8.ValidString(in.ActorReason) ||
		in.ActorReason != strings.TrimSpace(in.ActorReason) || utf8.RuneCountInString(in.ActorReason) < 10 ||
		utf8.RuneCountInString(in.ActorReason) > 950 || strings.IndexFunc(in.ActorReason, unicode.IsControl) >= 0 {
		return ErrInvalidInput
	}
	return nil
}

// ValidateInput allows the local operator to reject a malformed instruction
// before opening any connection. It is not payment/authorization verification.
func ValidateInput(in Input) error { return validateInput(in) }

type Preflight struct {
	DatabaseMatches bool   `json:"database_matches"`
	TargetMatches   bool   `json:"target_matches"`
	AffiliateSHA256 string `json:"affiliate_sha256"`
	PersonPublicID  string `json:"person_public_id"`
}

// Preflight reads metadata in an explicitly read-only transaction. It does not
// run the engine, reserve capacity, lock/write identities or prove manual cash.
func (s *Service) Preflight(parent context.Context, in Input) (Preflight, error) {
	if err := validateInput(in); err != nil {
		return Preflight{}, err
	}
	if s == nil || s.begin == nil || s.ready == nil || s.root <= 0 {
		return Preflight{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	tx, err := s.begin(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Preflight{}, ErrUnavailable
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='8s'; SET LOCAL TIME ZONE 'UTC'`); err != nil {
		return Preflight{}, ErrUnavailable
	}
	var database string
	if err := tx.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil || database != in.ExpectedDatabase {
		return Preflight{}, ErrUnavailable
	}
	if err := s.ready(ctx, tx); err != nil {
		return Preflight{}, ErrUnavailable
	}
	out := Preflight{DatabaseMatches: true}
	if err := tx.QueryRow(ctx, `SELECT p.public_id::text,
 encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),
 (p.status::text='active' AND a.status::text='active' AND p.is_admin IS FALSE AND NOT coalesce(p.blacklisted,false)
 AND p.public_id=$3::uuid AND NOT EXISTS(SELECT 1 FROM mlm.blacklist b
 WHERE mlm.norm_email(p.email) IS NOT NULL AND b.email_norm=mlm.norm_email(p.email)))
 FROM mlm.person p JOIN mlm.affiliate a ON a.person_id=p.id WHERE p.id=$1 AND a.id=$2`,
		in.PersonID, in.AffiliateID, in.PersonPublicID).Scan(&out.PersonPublicID, &out.AffiliateSHA256, &out.TargetMatches); err != nil {
		return Preflight{}, ErrTarget
	}
	out.TargetMatches = out.TargetMatches && out.AffiliateSHA256 == in.ExpectedAffiliateSHA256
	if err := tx.Commit(ctx); err != nil {
		return Preflight{}, ErrUnavailable
	}
	return out, nil
}

// Apply activates exactly the reviewed USD100/PV100 manual membership. It never
// credits principal to a wallet, posts compensation, emits tree_event or changes
// auth verification. Unknown commit outcomes must be inspected, never retried
// automatically. Replays require an identical immutable operation payload.
func (s *Service) Apply(parent context.Context, in Input) (Result, error) {
	if err := validateInput(in); err != nil {
		return Result{}, err
	}
	if s == nil || s.root <= 0 || s.begin == nil || s.ready == nil {
		return Result{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	tx, err := s.begin(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Result{}, ErrUnavailable
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer stop()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL TIME ZONE 'UTC'`); err != nil {
		return Result{}, ErrUnavailable
	}
	var database string
	var effective time.Time
	var operator, origin bool
	if err := tx.QueryRow(ctx, `SELECT current_database(),now(),
 has_table_privilege(current_user,'payments.manual_membership_order','INSERT'),
 current_setting('session_replication_role')='origin'`).Scan(&database, &effective, &operator, &origin); err != nil ||
		database != in.ExpectedDatabase || !operator || !origin {
		return Result{}, ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0))`); err != nil {
		return Result{}, ErrUnavailable
	}
	reason := "owner_instruction: " + in.ActorReason
	var existing int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM payments.manual_membership_order WHERE id=$1::uuid OR operation_key=$2`, in.ID, in.OperationKey).Scan(&existing); err != nil {
		return Result{}, ErrUnavailable
	}
	if existing > 0 {
		if existing != 1 {
			return Result{}, ErrConflict
		}
		var result Result
		var matches bool
		err := tx.QueryRow(ctx, `SELECT id::text,affiliate_package_id,investment_cd_id,effective_at,effective_at+interval '365 days',
 (id=$1::uuid AND operation_key=$2 AND person_id=$3 AND affiliate_id=$4 AND package_id=$5
 AND authorization_digest=$6 AND actor_reason=$7 AND state='activated'
 AND EXISTS(SELECT 1 FROM mlm.person p WHERE p.id=existing_order.person_id AND p.public_id=$8::uuid))
 FROM payments.manual_membership_order existing_order WHERE id=$1::uuid OR operation_key=$2 FOR UPDATE`,
			in.ID, in.OperationKey, in.PersonID, in.AffiliateID, in.PackageID, in.AuthorizationDigest, reason, in.PersonPublicID).
			Scan(&result.ID, &result.AffiliatePackageID, &result.CDID, &result.EffectiveAt, &result.MaturesAt, &matches)
		if err != nil || !matches {
			return Result{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Result{}, ErrCommitUnknown
		}
		result.Replay = true
		return result, nil
	}
	// Validate source/configuration BEFORE person locks, matching the scoped
	// executor and avoiding lock inversion with an in-flight NOW activation.
	if err := s.ready(ctx, tx); err != nil {
		return Result{}, ErrUnavailable
	}
	var publicID, status, fingerprint string
	var blocked, listed bool
	err = tx.QueryRow(ctx, `SELECT p.public_id::text,p.status::text,coalesce(p.blacklisted,false),
 EXISTS(SELECT 1 FROM mlm.blacklist b
 WHERE mlm.norm_email(p.email) IS NOT NULL AND b.email_norm=mlm.norm_email(p.email)),
 encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')
 FROM mlm.person p JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE p.id=$1 AND a.id=$2 AND a.status::text='active' AND p.is_admin IS FALSE FOR NO KEY UPDATE OF p,a`,
		in.PersonID, in.AffiliateID).Scan(&publicID, &status, &blocked, &listed, &fingerprint)
	if err != nil || publicID != in.PersonPublicID || status != "active" || blocked || listed {
		return Result{}, ErrTarget
	}
	if fingerprint != in.ExpectedAffiliateSHA256 {
		return Result{}, ErrStateDrift
	}
	var catalog bool
	if err := tx.QueryRow(ctx, `SELECT amount_usd=100 AND pv=100 AND is_active FROM mlm.package WHERE id=$1 FOR SHARE`, in.PackageID).Scan(&catalog); err != nil || !catalog {
		return Result{}, ErrTarget
	}
	var planID int64
	var lockDays int
	var capFactor, snapshot string
	if err := tx.QueryRow(ctx, `SELECT id,cd_lock_days,lifetime_cap_factor::text,to_jsonb(c)::text FROM mlm.plan_config c
 WHERE effective_from<=now() AND(effective_to IS NULL OR effective_to>now()) FOR SHARE`).
		Scan(&planID, &lockDays, &capFactor, &snapshot); err != nil || lockDays != 365 || !exactDecimal(capFactor, "2") {
		return Result{}, ErrUnavailable
	}
	var tiers, tierID int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=100 AND(max_amount_usd IS NULL OR max_amount_usd>100)`).Scan(&tiers); err != nil || tiers != 1 {
		return Result{}, ErrUnavailable
	}
	var base, qualified string
	if err := tx.QueryRow(ctx, `SELECT id,base_annual_rate::text,qualified_annual_rate::text FROM mlm.cd_roi_tier
 WHERE active AND min_amount_usd<=100 AND(max_amount_usd IS NULL OR max_amount_usd>100) FOR SHARE`).
		Scan(&tierID, &base, &qualified); err != nil || !exactDecimal(base, ".25") {
		return Result{}, ErrUnavailable
	}
	q, err := decimal.NewFromString(qualified)
	if err != nil || q.LessThan(decimal.RequireFromString(".30")) || q.GreaterThan(decimal.RequireFromString(".50")) {
		return Result{}, ErrUnavailable
	}
	if _, err := membershipsource.NewSource(membershipsource.Input{ID: in.ID, Kind: membershipsource.Manual, Currency: "usd",
		GrossUSD: "100.00", FeeUSD: "3.00", NetUSD: "97.00", PV: 100, EffectiveAt: effective}); err != nil {
		return Result{}, ErrUnavailable
	}
	maturity, err := membershipsource.Maturity365(effective)
	if err != nil {
		return Result{}, ErrUnavailable
	}
	var reviewedTriggers bool
	if err := tx.QueryRow(ctx, `SELECT
 (SELECT count(*)=1 AND bool_and(tgname='trg_init_package_cap' AND tgenabled IN('O','A')
 AND tgfoid='mlm.fn_init_package_cap()'::regprocedure) FROM pg_trigger
 WHERE tgrelid='mlm.affiliate_package'::regclass AND NOT tgisinternal)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN('mlm.investment_cd'::regclass,'mlm.wallet'::regclass) AND NOT tgisinternal)`).
		Scan(&reviewedTriggers); err != nil || !reviewedTriggers {
		return Result{}, ErrStateDrift
	}
	var packageID int64
	ref := "manual:production:" + in.ID
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.affiliate_package(affiliate_id,package_id,status,payment_method,transaction_hash,pv_remaining,activated_at,current_period_date)
 VALUES($1,$2,'active','manual',$3,100,now(),(now() AT TIME ZONE 'America/Bogota')::date) RETURNING id`,
		in.AffiliateID, in.PackageID, ref).Scan(&packageID); err != nil {
		return Result{}, ErrUnavailable
	}
	var total, paid string
	var closed bool
	if err := tx.QueryRow(ctx, `SELECT cap_total::text,paid_total::text,closed_at IS NOT NULL FROM mlm.package_cap_state
 WHERE affiliate_package_id=$1 FOR UPDATE`, packageID).Scan(&total, &paid, &closed); err != nil ||
		!exactDecimal(total, "200") || !exactDecimal(paid, "0") || closed {
		return Result{}, ErrStateDrift
	}
	var cdID int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.investment_cd(affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,start_at,matures_at)
 VALUES($1,$2,100,$3,now(),now()+interval '365 days') RETURNING id`, in.AffiliateID, packageID, tierID).Scan(&cdID); err != nil {
		return Result{}, ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `INSERT INTO mlm.wallet(affiliate_id,asset_id,address,balance)
 SELECT $1,id,$2,0 FROM mlm.asset WHERE symbol='USD' ON CONFLICT(affiliate_id,asset_id) DO NOTHING`,
		in.AffiliateID, "ledger:"+in.ID); err != nil {
		return Result{}, ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `INSERT INTO payments.manual_membership_order(id,operation_key,person_id,affiliate_id,package_id,
 affiliate_package_id,investment_cd_id,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,plan_snapshot,
 roi_base_annual_rate,roi_qualified_annual_rate,gross_usd,fee_rate,fee_usd,net_usd,pv,effective_at,approved_at,actor_reason,authorization_digest)
 VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,365,2,$10::jsonb,$11::numeric,$12::numeric,100,.03,3,97,100,now(),now(),$13,$14)`,
		in.ID, in.OperationKey, in.PersonID, in.AffiliateID, in.PackageID, packageID, cdID, planID, tierID,
		snapshot, base, qualified, reason, in.AuthorizationDigest); err != nil {
		return Result{}, ErrUnavailable
	}
	var after string
	var sources int
	if err := tx.QueryRow(ctx, `SELECT encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),
 (SELECT count(*) FROM payments.v_compensation_source s WHERE s.source_id=$2::uuid AND s.source_kind='manual'
 AND s.affiliate_id=a.id AND s.affiliate_package_id=$3 AND s.investment_cd_id=$4 AND s.gross_usd=100 AND s.net_usd=97 AND s.pv=100)
 FROM mlm.affiliate a WHERE a.id=$1`, in.AffiliateID, in.ID, packageID, cdID).Scan(&after, &sources); err != nil ||
		after != fingerprint || sources != 1 {
		return Result{}, ErrStateDrift
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, ErrCommitUnknown
	}
	return Result{ID: in.ID, AffiliatePackageID: packageID, CDID: cdID, EffectiveAt: effective, MaturesAt: maturity}, nil
}

func exactDecimal(value, expected string) bool {
	n, err := decimal.NewFromString(value)
	return err == nil && n.Equal(decimal.RequireFromString(expected))
}
