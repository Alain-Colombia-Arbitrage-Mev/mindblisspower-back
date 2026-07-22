// Tests de los streams v2 (ADR-0017/0018): carrera de rangos, fundadores,
// referido gen-1 y regalía gen-2.
package simulator

import (
	"io"
	"testing"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

// v2Plan: plan con todos los candados + streams v2 activos (config de
// lanzamiento: snapshot plan_config v2-candados + fundadores al 100%).
func v2Plan() PlanConfig {
	p := V1Conservative()
	p.DepthRepurchaseEnabled = true
	p.PurchaseStalePeriods = 4
	p.PauseMode = "reduce"
	p.YieldEnabled = true
	p.PointsBonusEnabled = true
	p.RanksEnabled = true
	p.FounderFraction = 1.0
	p.RoyaltyEnabled = true
	return p
}

// --- Carrera de rangos ---------------------------------------------------

func TestRanks_CrossingAwardsOncePerRank(t *testing.T) {
	tree := NewTree(1)
	root := tree.CreateRoot()
	a, _, _ := tree.AutoPlace(root, d("500")) // afiliado bajo prueba
	tree.AutoPlace(a, d("500"))               // hijo L
	tree.AutoPlace(a, d("500"))               // hijo R

	plan := V1Conservative()
	plan.RanksEnabled = true

	n := tree.Get(a)
	// 3,000 puntos por pierna → debe calificar Bronce (1,000) y Plata (2,500).
	n.LeftPVLifetime = d("3000")
	n.RightPVLifetime = d("3000")

	cands := computeRankCandidates(tree, root, plan)
	got := 0
	for _, c := range cands {
		if c.NodeID == a {
			got++
			// Marcar como lo hace run.go.
			if c.RankIdx > n.RankAchieved {
				n.RankAchieved = c.RankIdx
			}
		}
	}
	if got != 2 {
		t.Fatalf("esperaba 2 ascensos (Bronce, Plata) para el nodo, hubo %d", got)
	}
	if n.RankAchieved != 2 {
		t.Fatalf("RankAchieved debía ser 2 (Plata), es %d", n.RankAchieved)
	}

	// Segunda pasada sin puntos nuevos: NO debe re-emitir (one-time).
	again := computeRankCandidates(tree, root, plan)
	for _, c := range again {
		if c.NodeID == a {
			t.Fatalf("rango re-emitido para nodo ya marcado: idx=%d", c.RankIdx)
		}
	}

	// Pierna débil manda: 10,000 sólo a la izquierda NO sube de rango.
	n.LeftPVLifetime = d("13000")
	more := computeRankCandidates(tree, root, plan)
	for _, c := range more {
		if c.NodeID == a {
			t.Fatalf("ascenso con pierna derecha en 3,000 (< Oro 5,000): idx=%d", c.RankIdx)
		}
	}
}

func TestRanks_LifetimeNotConsumedByBlocks(t *testing.T) {
	// El PV de carrera no debe consumirse al pagar bloques (a diferencia
	// del PV corriente del binario).
	s := Default()
	s.InitialAffiliates = 200
	s.Periods = 8
	s.GrowthRate = 0.05
	s.Plan.RanksEnabled = true

	results, err := RunScenario(s, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	last := results[len(results)-1]
	if last.RanksAchieved == 0 {
		t.Fatal("esperaba al menos un hito alcanzado con 200 afiliados × 8 períodos")
	}
	// Monotonía: RanksAchieved nunca decrece.
	prev := 0
	for _, r := range results {
		if r.RanksAchieved < prev {
			t.Fatalf("RanksAchieved decreció: %d → %d (period %d)", prev, r.RanksAchieved, r.Period)
		}
		prev = r.RanksAchieved
	}
}

// --- Fundadores ----------------------------------------------------------

func TestFounders_BinaryPaysMatchedRate(t *testing.T) {
	// Mismo árbol, mismo PV: el candidato del fundador debe costar
	// matched × 10% = 5× el estándar ($10/bloque sobre bloques de 500).
	build := func(founder bool) decimal.Decimal {
		tree := NewTree(7)
		root := tree.CreateRoot()
		a, _, _ := tree.AutoPlace(root, d("1000"))
		l, _, _ := tree.AutoPlace(a, d("1000"))
		r, _, _ := tree.AutoPlace(a, d("1000"))
		tree.Get(a).IsFounder = founder

		plan := V1Conservative()
		events := []Event{
			{ID: 1, NodeID: l, PV: d("500"), USD: d("500")},
			{ID: 2, NodeID: r, PV: d("500"), USD: d("500")},
		}
		cands := enumerateCandidates(tree, events, plan)
		total := decimal.Zero
		for _, c := range cands {
			if c.AncestorID == a {
				total = total.Add(c.GrossAmount)
			}
		}
		return total
	}

	std := build(false)
	fnd := build(true)
	if std.IsZero() {
		t.Fatal("el caso estándar no generó bloques — fixture mal armado")
	}
	// 10% × 500 matched = $50/bloque vs $10/bloque estándar → ratio 5.
	ratio := fnd.Div(std)
	if !ratio.Equal(d("5")) {
		t.Fatalf("fundador/estándar debía ser 5×, fue %s (std=%s fnd=%s)", ratio, std, fnd)
	}
}

// --- Referido + regalía --------------------------------------------------

func TestReferralRoyalty_Generations(t *testing.T) {
	tree := NewTree(3)
	root := tree.CreateRoot()
	// Cadena de patrocinio: g2 patrocina a sp, sp patrocina a buyer.
	g2, _, _ := tree.AutoPlace(root, d("500"))
	sp, _, _ := tree.AutoPlace(g2, d("500"))
	buyer, _, _ := tree.AutoPlace(sp, d("500"))

	plan := V1Conservative()
	plan.RoyaltyEnabled = true
	plan.FounderFraction = 1.0
	tree.Get(sp).IsFounder = true

	// Gate del referido: sp necesita 1 directo activo a cada lado.
	tree.Get(sp).DirectsLeft = 1
	tree.Get(sp).DirectsRight = 1

	events := []Event{{ID: 1, NodeID: buyer, PV: d("200"), USD: d("200")}}
	refs, roys := computeReferralRoyalty(tree, events, plan)

	if len(refs) != 1 || refs[0].NodeID != sp || !refs[0].Amount.Equal(d("20")) {
		t.Fatalf("referido esperado: sp=%d $20 (10%% fundador de $200); got %+v", sp, refs)
	}
	if len(roys) != 1 || roys[0].NodeID != g2 || !roys[0].Amount.Equal(d("10")) {
		t.Fatalf("regalía esperada: g2=%d $10 (5%% de $200); got %+v", g2, roys)
	}

	// Sin gate (0 directos en un lado) el referido NO se paga; la regalía sí.
	tree.Get(sp).DirectsRight = 0
	refs2, roys2 := computeReferralRoyalty(tree, events, plan)
	if len(refs2) != 0 {
		t.Fatalf("referido sin gate de directos balanced debía ser 0, got %+v", refs2)
	}
	if len(roys2) != 1 {
		t.Fatalf("la regalía no depende del gate del referido; got %+v", roys2)
	}
}

// --- Invariantes con todo encendido ---------------------------------------

// TestV2_NoAbortWithAllStreams — D4: el cierre nunca debe abortar ni producir
// montos inválidos, incluso con todos los streams v2 encendidos y T1
// (SolvencyOK) roto en algunos períodos.
//
// Este test se llamaba TestV2_T1HoldsWithAllStreams y afirmaba SolvencyOK en
// TODOS los períodos. Esa aserción probaba el bug H1: en el simulador viejo
// el yield se escalaba por θ igual que cualquier otro stream, así que
// TotalPaid ≈ θ×projected ≤ α×inflows se cumplía por construcción — T1 era
// trivialmente cierto, sin importar cuánto yield se pagara.
//
// Tras D2 (el yield/ROI se paga COMPLETO, sin pasar por θ — ver el comentario
// en run.go junto al bucle de yield y cd_roi.go H1 en producción) eso ya no
// es una garantía estructural: en un período con θ<1, el yield paga de más
// respecto a lo que θ "presupuestó" para él en `projected`, y TotalPaid puede
// superar α×inflows. Éste es exactamente el comportamiento documentado en D4
// ("T1 no aborta el cierre — alerta y deja que θ module"), verificado en
// producción por bonusengine.TestH1_T1AlertsDoesNotAbort. Por eso este test
// ya NO exige SolvencyOK en cada período; sólo exige que el cierre complete
// sin error y sin montos negativos, y registra cuántos períodos rompieron T1
// (informativo, para que el sweep de la Task 5 lo cuantifique).
func TestV2_NoAbortWithAllStreams(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 1000
	s.Periods = 26
	s.GrowthRate = 0.04
	s.Plan = v2Plan()

	results, err := RunScenario(s, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != s.Periods {
		t.Fatalf("esperaba %d períodos, got %d", s.Periods, len(results))
	}
	var breaches int
	for _, r := range results {
		if !r.SolvencyOK {
			breaches++
		}
		if r.TotalPaid.IsNegative() {
			t.Fatalf("p=%d: TotalPaid negativo (%s) — el cierre nunca debe pagar de menos que cero", r.Period, r.TotalPaid)
		}
	}
	t.Logf("%d/%d períodos con SolvencyOK=false (D4: esperado — el yield sin θ puede romper T1 en períodos con θ<1)",
		breaches, len(results))
}

func TestV2_Determinism(t *testing.T) {
	run := func() decimal.Decimal {
		s := Default()
		s.InitialAffiliates = 500
		s.Periods = 12
		s.GrowthRate = 0.03
		s.Seed = 99
		s.Plan = v2Plan()
		results, err := RunScenario(s, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		total := decimal.Zero
		for _, r := range results {
			total = total.Add(r.TotalPaid)
		}
		return total
	}
	a, b := run(), run()
	if !a.Equal(b) {
		t.Fatalf("no determinístico con streams v2: %s vs %s", a, b)
	}
}

func TestV2_StreamsOffMatchesBaseline(t *testing.T) {
	// Con todos los flags v2 apagados, el resultado debe ser idéntico al
	// baseline previo (no-regresión: los hooks nuevos no consumen RNG ni
	// alteran θ cuando están off).
	base := Default()
	base.InitialAffiliates = 500
	base.Periods = 10
	base.Seed = 7

	v2off := base
	v2off.Plan = V1Conservative() // ya incluye campos v2 en off

	ra, err := RunScenario(base, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	rb, err := RunScenario(v2off, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	for i := range ra {
		if !ra[i].TotalPaid.Equal(rb[i].TotalPaid) || !ra[i].Theta.Equal(rb[i].Theta) {
			t.Fatalf("regresión con v2 off en period %d: paid %s vs %s",
				ra[i].Period, ra[i].TotalPaid, rb[i].TotalPaid)
		}
	}
}
