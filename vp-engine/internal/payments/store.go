package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
)

var (
	ErrPackNotFound        = errors.New("package not found or inactive")
	ErrBuyerNotFound       = errors.New("buyer (person) not found for user_id")
	ErrIntentNotFound      = errors.New("purchase_intent not found for session")
	ErrInvalidReferralCode = errors.New("invalid referral code")
)

// Store encapsula el acceso a Postgres del servicio de pagos.
// EngineURL (opcional): base del motor vp-engine para el simulador canónico de
// θ (POST /simulate). Vacío ⇒ el lock usa solo la proyección forward.
type Store struct {
	db        *pgxpool.Pool // PRIMARY (writes + reads si no hay réplica)
	dbRead    *pgxpool.Pool // réplica de lectura (opcional); nil ⇒ usa db
	EngineURL string
	cache     *Cache         // nil ⇒ sin caché (degrada a DB)
	log       zerolog.Logger // best-effort (comprobantes, eventos); Nop por defecto
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db, log: zerolog.Nop()} }

// SetCache inyecta la caché Redis (cache-aside). nil = deshabilitada.
func (s *Store) SetCache(c *Cache) { s.cache = c }

// SetLogger inyecta el logger para tareas best-effort (envío de comprobantes,
// eventos). Sin él, el Store usa zerolog.Nop().
func (s *Store) SetLogger(l zerolog.Logger) { s.log = l }

// SetReadPool inyecta la réplica de lectura (READ_DATABASE_URL). Los métodos de
// SOLO LECTURA (finance/solvency/member) la usan vía reader(); las escrituras
// siempre van al primary. nil = todo al primary.
func (s *Store) SetReadPool(p *pgxpool.Pool) { s.dbRead = p }

// reader devuelve la réplica si está configurada, si no el primary. Lag de
// réplica aceptable: los reads calientes ya van cacheados 15-20s.
func (s *Store) reader() *pgxpool.Pool {
	if s.dbRead != nil {
		return s.dbRead
	}
	return s.db
}

// Buyer es la identidad MLM resuelta desde el user_id de Cognito.
type Buyer struct {
	PersonID           int64
	AffiliateID        *int64 // null si aún no está colocado en el árbol
	SponsorAffiliateID *int64
}

// LookupPack lee un paquete activo del catálogo mlm.package.
func (s *Store) LookupPack(ctx context.Context, id int) (Pack, error) {
	var (
		p   Pack
		amt string
	)
	err := s.db.QueryRow(ctx, `
		SELECT id, name, amount_usd::text, pv
		  FROM mlm.package
		 WHERE id = $1 AND is_active
	`, id).Scan(&p.ID, &p.Name, &amt, &p.PV)
	if errors.Is(err, pgx.ErrNoRows) {
		return Pack{}, ErrPackNotFound
	}
	if err != nil {
		return Pack{}, fmt.Errorf("lookup pack: %w", err)
	}
	p.AmountUSD, err = decimal.NewFromString(amt)
	if err != nil {
		return Pack{}, fmt.Errorf("parse amount_usd %q: %w", amt, err)
	}
	return p, nil
}

// ResolveBuyer mapea el email (del id token Cognito) → person + affiliate/sponsor.
// Identificamos por email porque así lo hace el BFF Next (auth Cognito está
// desacoplado de mlm.person.user_id).
func (s *Store) ResolveBuyer(ctx context.Context, email string) (Buyer, error) {
	var b Buyer
	err := s.db.QueryRow(ctx, `
		SELECT p.id, a.id, a.sponsor_id
		  FROM mlm.person p
		  LEFT JOIN mlm.affiliate a ON a.person_id = p.id
		 WHERE lower(p.email) = lower($1)
		 LIMIT 1
	`, email).Scan(&b.PersonID, &b.AffiliateID, &b.SponsorAffiliateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Buyer{}, ErrBuyerNotFound
	}
	if err != nil {
		return Buyer{}, fmt.Errorf("resolve buyer: %w", err)
	}
	return b, nil
}

// SponsorIsBinaryAncestor valida que el patrocinador directo también sea
// ancestro estructural del afiliado en el árbol binario.
func (s *Store) SponsorIsBinaryAncestor(ctx context.Context, affiliateID, sponsorID int64) (bool, error) {
	if affiliateID <= 0 || sponsorID <= 0 {
		return false, nil
	}
	if affiliateID == sponsorID {
		return true, nil
	}
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM mlm.affiliate_closure
			 WHERE ancestor_id = $1
			   AND descendant_id = $2
			   AND distance > 0
		)`, sponsorID, affiliateID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("sponsor binary ancestor check: %w", err)
	}
	return ok, nil
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Store) SponsorCanReceivePlacement(ctx context.Context, sponsorID int64) (bool, error) {
	return sponsorCanReceivePlacement(ctx, s.db, sponsorID)
}

func sponsorCanReceivePlacement(ctx context.Context, q rowQuerier, sponsorID int64) (bool, error) {
	if sponsorID <= 0 {
		return false, nil
	}
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM mlm.affiliate a
			  JOIN mlm.person p ON p.id = a.person_id
			 WHERE a.id = $1
			   AND a.status::text = 'active'
			   AND p.status::text = 'active'
			   AND NOT COALESCE(p.blacklisted,false)
		)`, sponsorID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("sponsor placement eligibility: %w", err)
	}
	return ok, nil
}

// EnsurePerson garantiza que exista mlm.person para el email (auto-provisión de
// usuarios nuevos de Cognito que aún no tienen fila en RDS). Idempotente por
// email. Devuelve el person_id. La colocación en el árbol (affiliate) la hace la
// activación; aquí solo se asegura la identidad para que el checkout proceda.
func (s *Store) EnsurePerson(ctx context.Context, email, fullName, phone string) (int64, error) {
	if email == "" {
		return 0, fmt.Errorf("email vacío")
	}
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`, email).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("lookup person: %w", err)
	}
	first, last := splitName(fullName, email)
	if strings.TrimSpace(phone) == "" {
		phone = "-"
	}
	if err := s.db.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ($1, $2, $3, $4, 'active')
		ON CONFLICT (email) DO UPDATE SET updated_at = now()
		RETURNING id
	`, first, last, email, phone).Scan(&id); err != nil {
		return 0, fmt.Errorf("create person: %w", err)
	}
	return id, nil
}

// splitName parte un nombre completo en (first, last). Si viene vacío, usa la
// parte local del email como nombre.
func splitName(fullName, email string) (string, string) {
	fullName = strings.TrimSpace(fullName)
	if fullName == "" {
		local := email
		if i := strings.IndexByte(email, '@'); i > 0 {
			local = email[:i]
		}
		return local, local
	}
	parts := strings.Fields(fullName)
	if len(parts) == 1 {
		return parts[0], parts[0]
	}
	return parts[0], strings.Join(parts[1:], " ")
}

// PurchaseIntent representa una fila de payments.purchase_intent.
type PurchaseIntent struct {
	ID                  string
	UserID              string
	PersonID            int64
	AffiliateID         *int64
	SponsorAffiliateID  *int64
	ReferralCode        string
	PreferredSide       string
	PackageID           int
	PV                  int
	AmountUSD           decimal.Decimal
	FeeUSD              decimal.Decimal
	TotalCents          int64
	Currency            string
	Status              string
	StripePaymentIntent string
}

// CreatePurchaseIntent inserta un intent en estado 'created' y devuelve su id.
// MarkIntentStatus marca un purchase_intent como 'failed' o 'expired' cuando
// Stripe reporta que el pago no prosperó (tarjeta rechazada, sesión expirada,
// pantalla cerrada). Solo afecta intents en 'created' — nunca pisa
// 'activated'/'needs_placement'. Matchea por session id (eventos
// checkout.session) o por payment_intent id (eventos payment_intent); como el
// WHERE sólo toca filas de NUESTRA tabla, un evento de otro producto de la
// cuenta Stripe compartida no matchea nada (guard implícito). Idempotente.
// Sacar el intent de 'created' evita: recordatorios de carrito a tarjetas
// rechazadas, re-poll inútil del sweep, y que el panel de ventas nunca vea
// failed/expired.
func (s *Store) MarkIntentStatus(ctx context.Context, sessionID, paymentIntentID, newStatus string) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = $3,
		       stripe_payment_intent_id = COALESCE(NULLIF($2, ''), stripe_payment_intent_id),
		       updated_at = now()
		 WHERE status = 'created'
		   AND ( ($1 <> '' AND stripe_session_id = $1)
		      OR ($2 <> '' AND stripe_payment_intent_id = $2) )`,
		sessionID, paymentIntentID, newStatus)
	if err != nil {
		return 0, fmt.Errorf("mark intent %s: %w", newStatus, err)
	}
	return tag.RowsAffected(), nil
}

// MarkIntentStatusByIntentID cubre webhooks de payment_intent donde Stripe ya
// trae nuestro purchase_intent_id en metadata, pero aún no teníamos guardado el
// stripe_payment_intent_id/session_id. Mantiene el mismo gate: solo toca
// intents 'created', así un fallo tardío no revierte compras ya pagadas.
func (s *Store) MarkIntentStatusByIntentID(ctx context.Context, intentID, paymentIntentID, newStatus string) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = $3,
		       stripe_payment_intent_id = COALESCE(NULLIF($2, ''), stripe_payment_intent_id),
		       updated_at = now()
		 WHERE id = $1::uuid
		   AND status = 'created'`,
		intentID, paymentIntentID, newStatus)
	if err != nil {
		return 0, fmt.Errorf("mark intent %s by id: %w", newStatus, err)
	}
	return tag.RowsAffected(), nil
}

// MarkIntentRiskStatus marca un pago ya creado/cobrado con un estado de riesgo
// posterior: bloqueo de seguridad, disputa o chargeback. A diferencia de
// MarkIntentStatus, no limita a status='created' porque estos eventos llegan
// después del cobro inicial. Matchea solo nuestros intents por PaymentIntent.
func (s *Store) MarkIntentRiskStatus(ctx context.Context, paymentIntentID, newStatus string) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = $2, updated_at = now()
		 WHERE $1 <> ''
		   AND stripe_payment_intent_id = $1
		   AND status <> $2`,
		paymentIntentID, newStatus)
	if err != nil {
		return 0, fmt.Errorf("mark intent risk %s: %w", newStatus, err)
	}
	return tag.RowsAffected(), nil
}

func (s *Store) CreatePurchaseIntent(ctx context.Context, in PurchaseIntent) (string, error) {
	id, err := s.createPurchaseIntent(ctx, in, true)
	if isUndefinedColumn(err) {
		return s.createPurchaseIntent(ctx, in, false)
	}
	return id, err
}

func (s *Store) createPurchaseIntent(ctx context.Context, in PurchaseIntent, includeReferralCode bool) (string, error) {
	var id string
	if !includeReferralCode {
		err := s.db.QueryRow(ctx, `
			INSERT INTO payments.purchase_intent (
				user_id, person_id, affiliate_id, sponsor_affiliate_id,
				package_id, pv, amount_usd, fee_usd, total_cents, currency, status
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')
			RETURNING id::text
		`, in.UserID, in.PersonID, in.AffiliateID, in.SponsorAffiliateID,
			in.PackageID, in.PV, in.AmountUSD.String(), in.FeeUSD.String(), in.TotalCents, in.Currency).Scan(&id)
		if err != nil {
			return "", fmt.Errorf("create purchase_intent: %w", err)
		}
		return id, nil
	}

	err := s.db.QueryRow(ctx, `
		INSERT INTO payments.purchase_intent (
			user_id, person_id, affiliate_id, sponsor_affiliate_id, referral_code, preferred_side,
			package_id, pv, amount_usd, fee_usd, total_cents, currency, status
		) VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12,'created')
		RETURNING id::text
	`, in.UserID, in.PersonID, in.AffiliateID, in.SponsorAffiliateID,
		emptyToNil(in.ReferralCode), normalizePreferredSide(in.PreferredSide), in.PackageID, in.PV, in.AmountUSD.String(), in.FeeUSD.String(), in.TotalCents, in.Currency).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create purchase_intent: %w", err)
	}
	return id, nil
}

func isUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func emptyToNil(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

// AttachSession guarda el id de la sesión de Checkout creada.
func (s *Store) AttachSession(ctx context.Context, intentID, sessionID string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET stripe_session_id = $2, updated_at = now()
		 WHERE id = $1
	`, intentID, sessionID)
	return err
}

// EventSeen registra el id de evento de Stripe; devuelve true si YA estaba
// procesado (idempotencia a nivel de evento).
func (s *Store) EventSeen(ctx context.Context, eventID, eventType string) (bool, error) {
	tag, err := s.db.Exec(ctx, `
		INSERT INTO payments.stripe_event (event_id, type)
		VALUES ($1, $2)
		ON CONFLICT (event_id) DO NOTHING
	`, eventID, eventType)
	if err != nil {
		return false, fmt.Errorf("record stripe_event: %w", err)
	}
	return tag.RowsAffected() == 0, nil // 0 filas ⇒ ya existía
}

// (La activación pagada vive en activation.go: ActivatePaidPurchase, que marca
// pagado + coloca + liga paquete + PV en una sola transacción idempotente.)
