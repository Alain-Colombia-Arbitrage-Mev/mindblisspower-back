// ADR-0017/0018 — Carrera de Rangos: 14 hitos económicos one-time.
//
// Regla (definición de negocio 2026-06-04): un afiliado alcanza el rango N
// cuando sus puntos ACUMULADOS DE POR VIDA en CADA pierna alcanzan el
// threshold del rango (equivale a min(LeftPVLifetime, RightPVLifetime) ≥ X).
// Los puntos de carrera NO se consumen al pagar bloques binarios.
//
// El bono es FIJO por rango y se paga UNA sola vez, sujeto a T1 únicamente
// (entra a projected/θ; bypassa T2 y T3 — es premio de carrera, no comisión
// recurrente). El rango queda marcado como alcanzado aunque θ < 1: el bono
// one-time se liquida al neto del período del ascenso, sin reintentos —
// mismo contrato que mlm.affiliate_rank_achieved en producción.
package simulator

import "github.com/shopspring/decimal"

// RankDef define un hito de la carrera.
type RankDef struct {
	Name           string
	PointsEachSide decimal.Decimal // puntos requeridos en CADA pierna
	BonusUSD       decimal.Decimal // bono one-time fijo
}

// DefaultRankDefs devuelve la tabla real de 14 rangos (2026-06-04), espejo
// del seed de mlm.rank en _meta/schema_ranks.sql. Suma total: $305,950.
func DefaultRankDefs() []RankDef {
	d := func(s string) decimal.Decimal { return decimal.RequireFromString(s) }
	return []RankDef{
		{"Bronce", d("1000"), d("100")},
		{"Plata", d("2500"), d("200")},
		{"Oro", d("5000"), d("500")},
		{"Platino", d("10000"), d("750")},
		{"Zafiro", d("25000"), d("1000")},
		{"Rubí", d("50000"), d("2500")},
		{"Esmeralda", d("100000"), d("5000")},
		{"Diamante", d("250000"), d("10000")},
		{"Diamante Azul", d("500000"), d("15000")},
		{"Diamante Negro", d("750000"), d("20000")},
		{"Embajador", d("1000000"), d("25000")},
		{"Corona", d("5000000"), d("50000")},
		{"Royal", d("10000000"), d("75000")},
		{"King", d("25000000"), d("100000")},
	}
}

// rankEntry es un ascenso pendiente de pago en este período.
type rankEntry struct {
	NodeID  int64
	RankIdx int // 1-based en plan.RankDefs
	Bonus   decimal.Decimal
}

// computeRankCandidates devuelve los ascensos recién calificados (todavía no
// marcados). Debe llamarse DESPUÉS de enumerateCandidates (que acredita el PV
// del período vía AddPV). Un afiliado puede cruzar varios hitos en un mismo
// período (se emiten en orden). Determinístico: itera nodos ordenados por ID.
func computeRankCandidates(tree *Tree, rootID int64, plan PlanConfig) []rankEntry {
	if !plan.RanksEnabled || len(plan.RankDefs) == 0 {
		return nil
	}
	out := make([]rankEntry, 0)
	for _, n := range allNodes(tree, rootID) {
		if !n.Active {
			continue
		}
		qualifying := decimalMin(n.LeftPVLifetime, n.RightPVLifetime)
		for idx := n.RankAchieved; idx < len(plan.RankDefs); idx++ {
			def := plan.RankDefs[idx]
			if qualifying.LessThan(def.PointsEachSide) {
				break // thresholds son crecientes: si éste no, los siguientes tampoco
			}
			out = append(out, rankEntry{
				NodeID:  n.ID,
				RankIdx: idx + 1,
				Bonus:   def.BonusUSD,
			})
		}
	}
	return out
}

// countRanksAchieved suma los hitos alcanzados por toda la red (acumulado).
// Reportado en PeriodResult.RanksAchieved.
func countRanksAchieved(tree *Tree, rootID int64) int {
	total := 0
	for _, n := range allNodes(tree, rootID) {
		total += n.RankAchieved
	}
	return total
}
