package bonusengine

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// Estos tests son el GATE de equivalencia del cambio a tabla de closure.
// Prueban que:
//   1. trg_maintain_affiliate_closure mantiene mlm.affiliate_closure exacta
//      (conjuntos de ancestros, distancias, self-rows) al colocar nodos.
//   2. fn_apply_tree_event basado en closure produce EXACTAMENTE los mismos
//      left_count/right_count/left_pv_*/right_pv_* que la versión path-based.
//
// Requieren Docker (testcontainers pg17), igual que el resto de los integration
// tests del paquete.

// seedClosureTree arma un árbol binario conocido, dejando que los triggers
// (trg_affiliate_path BEFORE, trg_maintain_affiliate_closure AFTER) computen
// path/depth/closure. Devuelve los ids por etiqueta.
//
// Estructura:
//
//	root
//	├─ L: aL              (depth 1, pierna L de root)
//	│   ├─ L: aLL         (depth 2, pierna L de aL, pierna L de root)
//	│   └─ R: aLR         (depth 2, pierna R de aL, pierna L de root)
//	│       └─ L: aLRL    (depth 3)
//	└─ R: aR              (depth 1, pierna R de root)
//	    └─ R: aRR         (depth 2, pierna R de aR, pierna R de root)
func seedClosureTree(t *testing.T, ctx context.Context, pool *pgxpool.Pool) map[string]int64 {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1, 'CO', 'Colombia', 'Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1, 'USD', 'US Dollar', true, 2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
		  (11, 'binary_bonus', 'Bono binario', 'Binary bonus', 1, false, true);
	`); err != nil {
		t.Fatalf("catalogs: %v", err)
	}

	ids := map[string]int64{}
	nextPerson := 1
	// place inserta un afiliado bajo parent/pos y deja que los triggers computen
	// path/depth/closure. Pasa path/depth dummy: trg_affiliate_path los sobrescribe.
	place := func(label string, parent *int64, pos string) int64 {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
			VALUES ($1, 'test', $2, '0', 'active')`,
			fmt.Sprintf("p%d", nextPerson), fmt.Sprintf("p%d@t.local", nextPerson)); err != nil {
			t.Fatalf("person %s: %v", label, err)
		}
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
			VALUES ($1, $2, NULLIF($3,'')::mlm.tree_position, 'active', 'x'::ltree, 0)
			RETURNING id`, nextPerson, parent, pos).Scan(&id); err != nil {
			t.Fatalf("affiliate %s: %v", label, err)
		}
		nextPerson++
		ids[label] = id
		return id
	}

	root := place("root", nil, "")
	aL := place("aL", &root, "L")
	place("aLL", &aL, "L")
	aLR := place("aLR", &aL, "R")
	place("aLRL", &aLR, "L")
	aR := place("aR", &root, "R")
	place("aRR", &aR, "R")

	return ids
}

// TestClosureMaintenance verifica que mlm.affiliate_closure sea exactamente
// correcta tras colocar el árbol: cada nodo tiene su self-row (distance 0), y
// cada par (ancestro, descendiente) existe con la distancia correcta.
func TestClosureMaintenance(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	ids := seedClosureTree(t, ctx, pool)

	// Conjunto esperado de filas (ancestor_label, descendant_label, distance),
	// incluidas las self-rows (distance 0).
	type row struct{ anc, des string; dist int }
	expected := []row{
		// self-rows
		{"root", "root", 0}, {"aL", "aL", 0}, {"aLL", "aLL", 0},
		{"aLR", "aLR", 0}, {"aLRL", "aLRL", 0}, {"aR", "aR", 0}, {"aRR", "aRR", 0},
		// desde root
		{"root", "aL", 1}, {"root", "aLL", 2}, {"root", "aLR", 2},
		{"root", "aLRL", 3}, {"root", "aR", 1}, {"root", "aRR", 2},
		// desde aL
		{"aL", "aLL", 1}, {"aL", "aLR", 1}, {"aL", "aLRL", 2},
		// desde aLR
		{"aLR", "aLRL", 1},
		// desde aR
		{"aR", "aRR", 1},
	}

	// Set esperado indexado por (anc_id, des_id) -> dist.
	want := map[[2]int64]int{}
	for _, r := range expected {
		want[[2]int64{ids[r.anc], ids[r.des]}] = r.dist
	}

	rows, err := pool.Query(ctx, `SELECT ancestor_id, descendant_id, distance FROM mlm.affiliate_closure`)
	if err != nil {
		t.Fatalf("query closure: %v", err)
	}
	defer rows.Close()
	got := map[[2]int64]int{}
	for rows.Next() {
		var a, d int64
		var dist int
		if err := rows.Scan(&a, &d, &dist); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got[[2]int64{a, d}] = dist
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	if len(got) != len(want) {
		t.Errorf("closure tiene %d filas, esperado %d", len(got), len(want))
	}
	// Cada esperada debe existir con la distancia correcta.
	rev := map[int64]string{}
	for label, id := range ids {
		rev[id] = label
	}
	for k, wdist := range want {
		gdist, ok := got[k]
		if !ok {
			t.Errorf("falta fila closure (%s -> %s, dist %d)", rev[k[0]], rev[k[1]], wdist)
			continue
		}
		if gdist != wdist {
			t.Errorf("closure (%s -> %s): distance=%d, esperado %d", rev[k[0]], rev[k[1]], gdist, wdist)
		}
	}
	// Ninguna fila de más.
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("fila closure inesperada (%s -> %s)", rev[k[0]], rev[k[1]])
		}
	}
}

// TestApplyTreeEventClosure_Equivalence verifica que fn_apply_tree_event (ahora
// basado en closure) acredite los deltas de PV y los conteos de enrollment a
// EXACTAMENTE la pierna correcta de cada ancestro, con valores calculados a mano.
func TestApplyTreeEventClosure_Equivalence(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	ids := seedClosureTree(t, ctx, pool)

	// Helper: inserta un tree_event. El trigger AFTER lo aplica a los ancestros.
	// pv_delta va en el lado izq del row (la pierna real la decide el path del
	// afiliado en cada ancestro, no este campo).
	insertEvent := func(ext string, affLabel string, kind string, pvLeft, pvRight decimal.Decimal) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right)
			VALUES ($1, $2::mlm.tree_event_kind, $3, $4, $5)`,
			ext, kind, ids[affLabel], pvLeft, pvRight); err != nil {
			t.Fatalf("tree_event %s: %v", ext, err)
		}
	}

	d := decimal.NewFromInt
	// Eventos:
	//   e1: pv_credit sobre aLL, 100 PV (leg L). Ancestros: aL, root.
	//       - en aL, aLL está en su pierna L.
	//       - en root, aLL está bajo aL, que es pierna L de root -> L.
	//   e2: pv_credit sobre aLRL, 40 PV. Ancestros: aLR, aL, root.
	//       - en aLR, aLRL está en su pierna L.
	//       - en aL, aLRL está bajo aLR (pierna R de aL) -> R.
	//       - en root, aLRL está bajo aL (pierna L de root) -> L.
	//   e3: pv_credit sobre aRR, 70 PV. Ancestros: aR, root.
	//       - en aR, aRR está en su pierna R.
	//       - en root, aRR está bajo aR (pierna R de root) -> R.
	//   e4: enrollment sobre aLR (no PV, cuenta 1). Ancestros: aL, root.
	//       - en aL, aLR es pierna R -> right_count++.
	//       - en root, aLR está bajo aL (pierna L) -> left_count++.
	insertEvent("e1", "aLL", "pv_credit", d(100), d(0))
	insertEvent("e2", "aLRL", "pv_credit", d(40), d(0))
	insertEvent("e3", "aRR", "pv_credit", d(70), d(0))
	insertEvent("e4", "aLR", "enrollment", d(0), d(0))

	// Valores esperados por afiliado (hand-computed):
	//   root: L = 100 (e1) + 40 (e2) = 140 ; R = 70 (e3)
	//         left_count = 1 (e4) ; right_count = 0
	//   aL:   L = 100 (e1) ; R = 40 (e2)
	//         left_count = 0 ; right_count = 1 (e4, aLR es R de aL)
	//   aLR:  L = 40 (e2) ; R = 0 ; counts 0/0
	//   aR:   L = 0 ; R = 70 (e3) ; counts 0/0
	//   aLL, aLRL, aRR: hojas, sin descendientes -> 0 en todo.
	type exp struct {
		label                          string
		lLife, rLife, lCur, rCur       int64
		lCount, rCount                 int64
	}
	cases := []exp{
		{"root", 140, 70, 140, 70, 1, 0},
		{"aL", 100, 40, 100, 40, 0, 1},
		{"aLR", 40, 0, 40, 0, 0, 0},
		{"aR", 0, 70, 0, 70, 0, 0},
		{"aLL", 0, 0, 0, 0, 0, 0},
		{"aLRL", 0, 0, 0, 0, 0, 0},
		{"aRR", 0, 0, 0, 0, 0, 0},
	}

	for _, c := range cases {
		var lLife, rLife, lCur, rCur decimal.Decimal
		var lCount, rCount int64
		if err := pool.QueryRow(ctx, `
			SELECT left_pv_lifetime, right_pv_lifetime, left_pv_current, right_pv_current,
			       left_count, right_count
			  FROM mlm.affiliate WHERE id = $1`, ids[c.label]).Scan(
			&lLife, &rLife, &lCur, &rCur, &lCount, &rCount); err != nil {
			t.Fatalf("read %s: %v", c.label, err)
		}
		if !lLife.Equal(decimal.NewFromInt(c.lLife)) {
			t.Errorf("%s left_pv_lifetime=%s, esperado %d", c.label, lLife, c.lLife)
		}
		if !rLife.Equal(decimal.NewFromInt(c.rLife)) {
			t.Errorf("%s right_pv_lifetime=%s, esperado %d", c.label, rLife, c.rLife)
		}
		if !lCur.Equal(decimal.NewFromInt(c.lCur)) {
			t.Errorf("%s left_pv_current=%s, esperado %d", c.label, lCur, c.lCur)
		}
		if !rCur.Equal(decimal.NewFromInt(c.rCur)) {
			t.Errorf("%s right_pv_current=%s, esperado %d", c.label, rCur, c.rCur)
		}
		if lCount != c.lCount {
			t.Errorf("%s left_count=%d, esperado %d", c.label, lCount, c.lCount)
		}
		if rCount != c.rCount {
			t.Errorf("%s right_count=%d, esperado %d", c.label, rCount, c.rCount)
		}
	}

	// Sanity cruzado: la vista de reconciliación (también basada en closure)
	// debe coincidir con los agregados materializados para todo nodo.
	var drift int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.v_tree_pv_truth
		 WHERE materialized_left <> computed_left OR materialized_right <> computed_right`).Scan(&drift); err != nil {
		t.Fatalf("v_tree_pv_truth: %v", err)
	}
	if drift != 0 {
		t.Errorf("v_tree_pv_truth reporta %d nodos con drift (materializado != computado por closure)", drift)
	}
}
