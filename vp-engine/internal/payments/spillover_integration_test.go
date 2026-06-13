package payments

import (
	"context"
	"testing"
)

// Verifica el DERRAME (spillover): si el sponsor ya tiene ambas piernas (L y R)
// ocupadas, una nueva activación debe colocarse MÁS PROFUNDO (no directo bajo el
// sponsor) siguiendo la regla weak-leg. Requiere Docker.
func TestSpillover_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1001,'Pack',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status) OVERRIDING SYSTEM VALUE VALUES
		  (1,'Spon','Sor','s@t.local','0','active'),
		  (2,'Hijo','Izq','l@t.local','0','active'),
		  (3,'Hijo','Der','r@t.local','0','active'),
		  (4,'Nuevo','Comprador','buyer@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Sponsor (raíz) con ambas piernas ocupadas.
	var sponsor, leftID, rightID int64
	pool.QueryRow(ctx, `INSERT INTO mlm.affiliate (person_id,parent_id,position,status,path,depth) VALUES (1,NULL,NULL,'active',''::ltree,0) RETURNING id`).Scan(&sponsor)
	pool.QueryRow(ctx, `INSERT INTO mlm.affiliate (person_id,parent_id,position,sponsor_id,status,path,depth) VALUES (2,$1,'L',$1,'active',''::ltree,0) RETURNING id`, sponsor).Scan(&leftID)
	pool.QueryRow(ctx, `INSERT INTO mlm.affiliate (person_id,parent_id,position,sponsor_id,status,path,depth) VALUES (3,$1,'R',$1,'active',''::ltree,0) RETURNING id`, sponsor).Scan(&rightID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv, amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ('buyer@t.local', 4, NULL, $1, 1001, 500, 1000, 10, 101000, 'usd', 'created', 'cs_spill')
	`, sponsor); err != nil {
		t.Fatalf("intent: %v", err)
	}

	res, err := NewStore(pool).ActivatePaidPurchase(ctx, "cs_spill", "pi_spill")
	if err != nil || res.Status != "activated" {
		t.Fatalf("activate: status=%s err=%v", res.Status, err)
	}

	// El comprador NO debe quedar directo bajo el sponsor (ambas piernas llenas)
	// sino bajo uno de sus hijos (depth 2) — eso es el derrame.
	var parent int64
	var depth int
	if err := pool.QueryRow(ctx, `SELECT parent_id, depth FROM mlm.affiliate WHERE person_id=4`).Scan(&parent, &depth); err != nil {
		t.Fatalf("buyer affiliate: %v", err)
	}
	if parent == sponsor {
		t.Fatalf("NO derramó: quedó directo bajo el sponsor (parent=%d)", sponsor)
	}
	if parent != leftID && parent != rightID {
		t.Fatalf("parent inesperado %d (esperado hijo %d o %d)", parent, leftID, rightID)
	}
	if depth != 2 {
		t.Fatalf("depth=%d, esperado 2 (derrame a 2º nivel)", depth)
	}
	t.Logf("derrame OK: comprador colocado bajo afiliado %d en depth %d", parent, depth)
}
