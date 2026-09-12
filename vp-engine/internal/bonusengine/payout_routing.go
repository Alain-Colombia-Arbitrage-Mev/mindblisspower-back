package bonusengine

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type payoutRoute struct {
	affiliateID int64
	redirected  bool
}

// effectivePayoutAffiliateID conserva la topologia del binario, pero redirige
// el dinero a empresa cuando el beneficiario pertenece a una rama bloqueada.
func effectivePayoutAffiliateID(
	ctx context.Context,
	tx pgx.Tx,
	affiliateID int64,
	companyRootAffiliateID int64,
	cache map[int64]payoutRoute,
) (payoutRoute, error) {
	if affiliateID <= 0 {
		return payoutRoute{}, fmt.Errorf("invalid affiliate id %d", affiliateID)
	}
	if companyRootAffiliateID <= 0 || affiliateID == companyRootAffiliateID {
		return payoutRoute{affiliateID: affiliateID}, nil
	}
	if cache != nil {
		if route, ok := cache[affiliateID]; ok {
			return route, nil
		}
	}

	var blocked bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM mlm.affiliate a
			  JOIN mlm.person p ON p.id = a.person_id
			 WHERE (
			        a.id = $1
			     OR EXISTS (
			          SELECT 1
			            FROM mlm.affiliate_closure c
			           WHERE c.descendant_id = $1
			             AND c.ancestor_id = a.id
			        )
			       )
			   AND (
			        a.status::text IN ('deleted','suspended','banned')
			     OR p.status::text IN ('deleted','suspended','banned')
			     OR COALESCE(p.blacklisted, false)
			     OR EXISTS (
			          SELECT 1
			            FROM mlm.blacklist b
			           WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
			              OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
			              OR (b.name_norm IS NOT NULL
			                  AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
			                  AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
			        )
			       )
		)`, affiliateID).Scan(&blocked); err != nil {
		return payoutRoute{}, fmt.Errorf("check payout route aff=%d: %w", affiliateID, err)
	}

	route := payoutRoute{affiliateID: affiliateID}
	if blocked {
		route = payoutRoute{affiliateID: companyRootAffiliateID, redirected: true}
	}
	if cache != nil {
		cache[affiliateID] = route
	}
	return route, nil
}
