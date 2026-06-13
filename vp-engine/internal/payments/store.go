package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

var (
	ErrPackNotFound   = errors.New("package not found or inactive")
	ErrBuyerNotFound  = errors.New("buyer (person) not found for user_id")
	ErrIntentNotFound = errors.New("purchase_intent not found for session")
)

// Store encapsula el acceso a Postgres del servicio de pagos.
// EngineURL (opcional): base del motor vp-engine para el simulador canónico de
// θ (POST /simulate). Vacío ⇒ el lock usa solo la proyección forward.
type Store struct {
	db        *pgxpool.Pool
	EngineURL string
	cache     *Cache // nil ⇒ sin caché (degrada a DB)
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

// SetCache inyecta la caché Redis (cache-aside). nil = deshabilitada.
func (s *Store) SetCache(c *Cache) { s.cache = c }

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

// PurchaseIntent representa una fila de payments.purchase_intent.
type PurchaseIntent struct {
	ID                 string
	UserID             string
	PersonID           int64
	AffiliateID        *int64
	SponsorAffiliateID *int64
	PackageID          int
	PV                 int
	AmountUSD          decimal.Decimal
	FeeUSD             decimal.Decimal
	TotalCents         int64
	Currency           string
	Status             string
	StripePaymentIntent string
}

// CreatePurchaseIntent inserta un intent en estado 'created' y devuelve su id.
func (s *Store) CreatePurchaseIntent(ctx context.Context, in PurchaseIntent) (string, error) {
	var id string
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
