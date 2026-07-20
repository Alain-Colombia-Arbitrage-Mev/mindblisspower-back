package withdrawals

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrLinkPending: ya hay una solicitud de vínculo esperando revisión.
var ErrLinkPending = errors.New("ya existe una solicitud de vínculo pendiente")

// ErrBMPEmailUnknown: BMP no reconoce el email que se quiere vincular.
var ErrBMPEmailUnknown = errors.New("BMP no reconoce ese email")

// ErrLinkNotPending: el vínculo no está en 'pending_admin', así que no se puede
// revisar. Evita que una doble aprobación reescriba la auditoría de la primera.
var ErrLinkNotPending = errors.New("el vínculo no está pendiente de revisión")

// Nombres de los índices parciales únicos de mlm.bmp_account_link. Son el
// contrato con la migración 50: la BASE es la que garantiza las invariantes
// (un solo aprobado y un solo pendiente por afiliado), el código sólo traduce
// su violación a un error de negocio.
const (
	idxOnePendingLink  = "bmp_account_link_one_pending"
	idxOneApprovedLink = "bmp_account_link_one_approved"
)

// BMPLink es una solicitud de vínculo en la cola admin.
type BMPLink struct {
	ID          int64  `json:"id"`
	Member      string `json:"member"`
	MemberEmail string `json:"member_email"`
	BMPEmail    string `json:"bmp_email"`
	Status      string `json:"status"`
	BMPUserID   string `json:"bmp_user_id"`
	BlockReason string `json:"bmp_block_reason"`
	RequestedAt string `json:"requested_at"`
}

// uniqueViolationOn devuelve true si err es una violación de unicidad (SQLSTATE
// 23505) sobre el índice `name`.
//
// Se inspecciona el *pgconn.PgError, NO el texto del mensaje: el mensaje es
// formato (y está localizado por el server), el SQLSTATE y el nombre de la
// constraint son contrato.
func uniqueViolationOn(err error, name string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23505" && pgErr.ConstraintName == name
}

// RequestBMPLink registra la solicitud de vincular un email BMP alterno. Queda
// en 'pending_admin': el afiliado NO puede usarlo hasta que un admin lo apruebe
// (D2 — evita que alguien desvíe su retiro al email BMP de un tercero).
//
// Se exige que BMP reconozca el email: vincular uno inexistente no tiene sentido
// y llenaría la cola admin de basura.
//
// Se persiste v.UserID: el email puede cambiar en BMP, el userId no, así que es
// el ancla estable de identidad para la auditoría del vínculo.
func (s *Store) RequestBMPLink(ctx context.Context, memberEmail, bmpEmail, ip string, v BMPVerification) (int64, error) {
	bmpEmail = strings.ToLower(strings.TrimSpace(bmpEmail))
	if bmpEmail == "" {
		return 0, fmt.Errorf("bmp email vacío")
	}
	if !v.Exists {
		return 0, ErrBMPEmailUnknown
	}

	var affID int64
	err := s.db.QueryRow(ctx, `
		SELECT a.id FROM mlm.person p
		  JOIN mlm.affiliate a ON a.person_id = p.id
		 WHERE lower(p.email)=lower($1) LIMIT 1`, memberEmail).Scan(&affID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNoWallet
	}
	if err != nil {
		return 0, fmt.Errorf("resolve affiliate: %w", err)
	}

	var id int64
	err = s.db.QueryRow(ctx, `
		INSERT INTO mlm.bmp_account_link
		  (affiliate_id, bmp_email, status, bmp_user_id, bmp_block_reason, requested_from_ip)
		VALUES ($1, $2, 'pending_admin', NULLIF($3,''), NULLIF($4,''), NULLIF($5,'')::inet)
		RETURNING id`, affID, bmpEmail, v.UserID, v.BlockReason, strings.TrimSpace(ip)).Scan(&id)
	if err != nil {
		// El índice parcial único bmp_account_link_one_pending rebota la segunda:
		// es una condición de negocio ("ya tenés una en revisión"), no una falla
		// de infraestructura, así que se traduce en vez de propagarse cruda.
		if uniqueViolationOn(err, idxOnePendingLink) {
			return 0, ErrLinkPending
		}
		return 0, fmt.Errorf("insert bmp link: %w", err)
	}
	return id, nil
}

// ListPendingBMPLinks devuelve la cola de vínculos por revisar.
func (s *Store) ListPendingBMPLinks(ctx context.Context, limit, offset int) ([]BMPLink, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	var total int64
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM mlm.bmp_account_link WHERE status='pending_admin'`).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count bmp links: %w", err)
	}
	rows, err := s.db.Query(ctx, `
		SELECT l.id, trim(p.first_name||' '||p.last_name), p.email, l.bmp_email,
		       l.status::text, COALESCE(l.bmp_user_id,''), COALESCE(l.bmp_block_reason,''),
		       to_char(l.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
		  FROM mlm.bmp_account_link l
		  JOIN mlm.affiliate a ON a.id = l.affiliate_id
		  JOIN mlm.person p    ON p.id = a.person_id
		 WHERE l.status='pending_admin'
		 ORDER BY l.requested_at DESC
		 LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list bmp links: %w", err)
	}
	defer rows.Close()
	out := []BMPLink{}
	for rows.Next() {
		var l BMPLink
		if err := rows.Scan(&l.ID, &l.Member, &l.MemberEmail, &l.BMPEmail,
			&l.Status, &l.BMPUserID, &l.BlockReason, &l.RequestedAt); err != nil {
			return nil, 0, fmt.Errorf("scan bmp link: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("list bmp links: %w", err)
	}
	return out, total, nil
}

// ReviewBMPLink aprueba o rechaza una solicitud. Solo transiciona DESDE
// 'pending_admin', de modo que una doble aprobación no reescribe la auditoría
// (quién revisó, cuándo y con qué nota) de la primera.
func (s *Store) ReviewBMPLink(ctx context.Context, id int64, approve bool, adminEmail, note string) error {
	status := "rejected"
	if approve {
		status = "approved"
	}
	ct, err := s.db.Exec(ctx, `
		UPDATE mlm.bmp_account_link
		   SET status=$2::mlm.bmp_link_status,
		       reviewed_by_person_id=(SELECT id FROM mlm.person WHERE lower(email)=lower($3) LIMIT 1),
		       reviewed_at=now(), review_note=NULLIF($4,''), updated_at=now()
		 WHERE id=$1 AND status='pending_admin'`, id, status, adminEmail, note)
	if err != nil {
		// El afiliado ya tiene otro vínculo aprobado: la BASE lo impide y eso es
		// correcto — aprobar dos correos BMP a la vez dejaría ambiguo a dónde va
		// el dinero. Se reporta como conflicto, no como falla.
		if uniqueViolationOn(err, idxOneApprovedLink) {
			return fmt.Errorf("el afiliado ya tiene un vínculo BMP aprobado: %w", ErrLinkNotPending)
		}
		return fmt.Errorf("review bmp link: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("vínculo %d: %w", id, ErrLinkNotPending)
	}
	return nil
}

// ApprovedBMPEmail devuelve el email BMP vinculado y APROBADO del afiliado, o
// cadena vacía si no tiene ninguno.
//
// Un vínculo en 'pending_admin' no cuenta: ese es justamente el punto de la
// aprobación admin. Devolverlo acá reabriría el vector de desviar un retiro al
// email BMP de un tercero sin que nadie lo revise.
func (s *Store) ApprovedBMPEmail(ctx context.Context, memberEmail string) (string, error) {
	var bmpEmail string
	err := s.db.QueryRow(ctx, `
		SELECT l.bmp_email
		  FROM mlm.bmp_account_link l
		  JOIN mlm.affiliate a ON a.id = l.affiliate_id
		  JOIN mlm.person p    ON p.id = a.person_id
		 WHERE lower(p.email)=lower($1) AND l.status='approved'
		 LIMIT 1`, memberEmail).Scan(&bmpEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("approved bmp email: %w", err)
	}
	return bmpEmail, nil
}
