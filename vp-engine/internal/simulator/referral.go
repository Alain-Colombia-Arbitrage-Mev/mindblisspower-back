// ADR-0018 — Bono referido (gen-1) y Regalía (gen-2) sobre la línea de
// patrocinio.
//
//   - Referido: % de cada pago del patrocinado directo, para su sponsor.
//     Fundadores cobran FounderReferralRate (10%); no-fundadores
//     ReferralRate (default 0, pendiente de definir). Gate: el sponsor debe
//     tener 1 directo activo a cada lado (mismo gate que R2 — "se habilita
//     al activar uno a cada lado", plan integral §1).
//   - Regalía: RoyaltyRate (5%) de cada pago de la 2ª generación de
//     patrocinio ("si esos socios traen más usuarios, el 5% de cada pago").
//
// Ambos entran a projected/θ (T1) y bypasean T2/T3 — son comisiones de
// venta directa, no del binario. v1 del simulador los aplica sobre los
// eventos de contribución recurrente (la base de inflows del modelo);
// las renovaciones R1 no generan referido/regalía en v1.
package simulator

import "github.com/shopspring/decimal"

// payEntry es un pago pendiente (referido o regalía) para un nodo.
type payEntry struct {
	NodeID int64
	Amount decimal.Decimal
}

// computeReferralRoyalty recorre los eventos del período y devuelve los
// pagos de referido (gen-1) y regalía (gen-2) que generan. Determinístico:
// el orden sigue el de events (ya determinístico por construcción).
func computeReferralRoyalty(tree *Tree, events []Event, plan PlanConfig) (refs, roys []payEntry) {
	royaltyOn := plan.RoyaltyEnabled && plan.RoyaltyRate.GreaterThan(decimal.Zero)
	for _, evt := range events {
		node := tree.Get(evt.NodeID)
		if node == nil || node.SponsorID == 0 {
			continue
		}
		sponsor := tree.Get(node.SponsorID)
		if sponsor == nil {
			continue
		}

		// Gen-1 — referido. La raíz (empresa) no cobra.
		if sponsor.ParentID != 0 && sponsor.Active && isQualifiedR2(sponsor) {
			rate := plan.ReferralRate
			if sponsor.IsFounder {
				rate = plan.FounderReferralRate
			}
			if rate.GreaterThan(decimal.Zero) {
				amt := evt.USD.Mul(rate).RoundDown(2)
				if amt.Sign() > 0 {
					refs = append(refs, payEntry{NodeID: sponsor.ID, Amount: amt})
				}
			}
		}

		// Gen-2 — regalía al sponsor del sponsor.
		if royaltyOn && sponsor.SponsorID != 0 {
			g2 := tree.Get(sponsor.SponsorID)
			if g2 != nil && g2.ParentID != 0 && g2.Active {
				amt := evt.USD.Mul(plan.RoyaltyRate).RoundDown(2)
				if amt.Sign() > 0 {
					roys = append(roys, payEntry{NodeID: g2.ID, Amount: amt})
				}
			}
		}
	}
	return refs, roys
}
