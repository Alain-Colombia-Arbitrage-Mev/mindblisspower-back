package simulator

import (
	"github.com/shopspring/decimal"
)

// Candidate is a potential payment to one ancestor caused by one event.
// Mirrors bonusengine.Candidate but lives outside the DB world.
type Candidate struct {
	AncestorID    int64
	SourceEventID int64
	NewBlocks     int
	Side          string          // L or R, ancestor's perspective
	GrossAmount   decimal.Decimal // r × NewBlocks before caps
	DailyReduce   decimal.Decimal // amount trimmed by daily cap
	PackageReduce decimal.Decimal // amount trimmed by package cap
}

// computeTheta replicates ADR-0012 §2 / binary_close.go:ComputeTheta.
// θ = clamp(α × inflows / projected, 0, 1).
func computeTheta(alpha, inflows, projected decimal.Decimal) decimal.Decimal {
	if projected.IsZero() {
		return decimal.NewFromInt(1)
	}
	raw := alpha.Mul(inflows).Div(projected)
	one := decimal.NewFromInt(1)
	if raw.GreaterThan(one) {
		return one
	}
	if raw.LessThan(decimal.Zero) {
		return decimal.Zero
	}
	return raw.Round(6)
}

// enumerateCandidates: for each event, walk ancestors up to DepthCap, compute
// new blocks payable based on weaker-leg matching.
//
// Qualification mirrors the production tree rule:
//   - Own active package.
//   - If Q_L/Q_R > 0, active immediate binary child on that leg.
//   - If Q_L/Q_R > 0, at least Q personally-sponsored active directs placed
//     in that same binary leg. Spillover volume alone does not qualify.
//
// PV credit = event package price (1 USD = 1 PV).
//
// Weaker-leg block math:
//
//	blocks = floor(min(LeftPV + LeftCarry, RightPV + RightCarry) / BlockSize)
//	              - blocksAlreadyPaidThisPeriod
//	After paying B*blocks each side, the surplus on the strong side becomes carry.
func enumerateCandidates(
	tree *Tree,
	events []Event,
	plan PlanConfig,
) []Candidate {
	out := make([]Candidate, 0, len(events)*plan.DepthCap)
	blockUSD := plan.BonusPerBlock
	blockSize := decimal.NewFromInt(int64(plan.BlockSize))

	// Bloques ya emitidos a cada ancestro DENTRO de este período. Espejo del
	// blocksPaid del motor real (candidate.go): sin esto, N eventos que
	// golpean al mismo ancestro re-cuentan el mismo weak-leg acumulado N
	// veces, inflando projected (y hundiendo θ) en períodos de ráfaga.
	blocksEmitted := map[int64]int64{}
	qualification := buildBinaryQualificationState(tree)

	for _, evt := range events {
		ancestors := tree.Ancestors(evt.NodeID, plan.DepthCap)
		// Credit the PV to ancestors first; the candidate math reads updated PV.
		tree.AddPV(evt.NodeID, evt.PV, plan.DepthCap)

		for _, anc := range ancestors {
			if !isQualifiedBinaryCandidate(tree, anc, plan, qualification) {
				continue
			}
			// ADR-0013 R1 — P-A skip mode: ancestor not enumerated.
			// For P-B and P-C we still enumerate; the decision happens at
			// payment time so the math (θ, caps) sees them.
			if !isQualifiedR1(anc, plan) && plan.PauseMode == "skip" {
				continue
			}

			lTotal := anc.LeftPV.Add(anc.LeftCarry)
			rTotal := anc.RightPV.Add(anc.RightCarry)
			weak := decimalMin(lTotal, rTotal)
			blocks := weak.Div(blockSize).IntPart() - blocksEmitted[anc.ID]
			if blocks <= 0 {
				continue
			}
			blocksEmitted[anc.ID] += blocks

			// Determine which side is "the weak leg" for record-keeping.
			side := "L"
			if rTotal.LessThan(lTotal) {
				side = "R"
			}

			gross := blockUSD.Mul(decimal.NewFromInt(blocks))
			// ADR-0018 — fundadores: el binario paga % del matched volume
			// (FounderBinaryMatchedRate × blocks × BlockSize) en lugar del
			// $/bloque estándar. 10% vs 2% ($10/500) = 5× el costo.
			if anc.IsFounder && plan.FounderBinaryMatchedRate.GreaterThan(decimal.Zero) {
				matched := blockSize.Mul(decimal.NewFromInt(blocks))
				gross = plan.FounderBinaryMatchedRate.Mul(matched).RoundDown(2)
			}

			out = append(out, Candidate{
				AncestorID:    anc.ID,
				SourceEventID: evt.ID,
				NewBlocks:     int(blocks),
				Side:          side,
				GrossAmount:   gross,
			})
		}
	}
	return out
}

type binaryQualificationState struct {
	sponsoredLeft  map[int64]int
	sponsoredRight map[int64]int
}

func buildBinaryQualificationState(tree *Tree) binaryQualificationState {
	state := binaryQualificationState{
		sponsoredLeft:  make(map[int64]int),
		sponsoredRight: make(map[int64]int),
	}
	for _, node := range tree.nodes {
		if node.SponsorID == 0 {
			continue
		}
		if !node.Active || node.PackageClosed || node.PackagePrice.Sign() <= 0 {
			continue
		}
		sponsor := tree.Get(node.SponsorID)
		if sponsor == nil {
			continue
		}
		side, ok := binarySideUnderAncestor(tree, sponsor, node.ID)
		if !ok {
			continue
		}
		if side == "L" {
			state.sponsoredLeft[sponsor.ID]++
		} else {
			state.sponsoredRight[sponsor.ID]++
		}
	}
	return state
}

func isQualifiedBinaryCandidate(tree *Tree, n *Node, plan PlanConfig, state binaryQualificationState) bool {
	if n == nil || n.ParentID == 0 {
		return false
	}
	if !n.Active || n.PackageClosed || n.PackagePrice.Sign() <= 0 {
		return false
	}
	if plan.QualifiedDirectsLeft > 0 {
		if !hasActiveBinaryChild(tree, n, "L") {
			return false
		}
		if state.sponsoredLeft[n.ID] < plan.QualifiedDirectsLeft {
			return false
		}
	}
	if plan.QualifiedDirectsRight > 0 {
		if !hasActiveBinaryChild(tree, n, "R") {
			return false
		}
		if state.sponsoredRight[n.ID] < plan.QualifiedDirectsRight {
			return false
		}
	}
	return true
}

func hasActiveBinaryChild(tree *Tree, n *Node, side string) bool {
	childID := n.LeftID
	if side == "R" {
		childID = n.RightID
	}
	child := tree.Get(childID)
	return child != nil && child.Active
}

func binarySideUnderAncestor(tree *Tree, ancestor *Node, descendantID int64) (string, bool) {
	cur := tree.Get(descendantID)
	for cur != nil && cur.ParentID != 0 {
		if cur.ParentID == ancestor.ID {
			if ancestor.LeftID == cur.ID {
				return "L", true
			}
			if ancestor.RightID == cur.ID {
				return "R", true
			}
			return "", false
		}
		cur = tree.Get(cur.ParentID)
	}
	return "", false
}

// applyCaps clips each candidate by T2 (per-package) and T3 (per-day).
// Returns the trimmed list AND a Breakage report.
func applyCaps(
	candidates []Candidate,
	tree *Tree,
	plan PlanConfig,
) ([]Candidate, Breakage) {
	out := make([]Candidate, 0, len(candidates))
	var br Breakage
	for _, c := range candidates {
		anc := tree.Get(c.AncestorID)
		if anc == nil {
			continue
		}

		// T3 — period cap. ADR-0014: leadership ranks removed.
		// New model: cap = PeriodCapFactor × PackagePrice. Bigger package
		// → bigger cap, no rank tiering. Falls back to legacy
		// DailyCapFactor × RankBonusBase if PeriodCapFactor == 0.
		var dailyCap decimal.Decimal
		if plan.PeriodCapFactor.GreaterThan(decimal.Zero) {
			dailyCap = plan.PeriodCapFactor.Mul(anc.PackagePrice)
		} else {
			dailyCap = plan.DailyCapFactor.Mul(plan.RankBonusBase)
		}
		remainingDaily := dailyCap.Sub(anc.PeriodPaid)
		if remainingDaily.LessThanOrEqual(decimal.Zero) {
			br.DailyCapHits++
			br.DailyCapReducedUSD = br.DailyCapReducedUSD.Add(c.GrossAmount)
			continue
		}
		net := c.GrossAmount
		if net.GreaterThan(remainingDaily) {
			c.DailyReduce = net.Sub(remainingDaily)
			br.DailyCapReducedUSD = br.DailyCapReducedUSD.Add(c.DailyReduce)
			net = remainingDaily
		}

		// T2: per-package lifetime cap = K_pkg × package_price.
		pkgCap := plan.LifetimeCapFactor.Mul(anc.PackagePrice)
		remainingPkg := pkgCap.Sub(anc.PackagePaid)
		if remainingPkg.LessThanOrEqual(decimal.Zero) {
			anc.PackageClosed = true
			br.PackageCapHits++
			br.PackageCapReducedUSD = br.PackageCapReducedUSD.Add(c.GrossAmount)
			continue
		}
		if net.GreaterThan(remainingPkg) {
			c.PackageReduce = net.Sub(remainingPkg)
			br.PackageCapReducedUSD = br.PackageCapReducedUSD.Add(c.PackageReduce)
			net = remainingPkg
		}

		c.GrossAmount = net
		out = append(out, c)
	}
	return out, br
}

// Breakage aggregates causes of payment shrinkage. The math invariant is
// margin = inflows - paid; breakage explains where the company kept money.
type Breakage struct {
	DailyCapHits         int
	DailyCapReducedUSD   decimal.Decimal
	PackageCapHits       int
	PackageCapReducedUSD decimal.Decimal
	ThetaReducedUSD      decimal.Decimal
	CarryExpiredUSD      decimal.Decimal
}

func decimalMin(a, b decimal.Decimal) decimal.Decimal {
	if a.LessThan(b) {
		return a
	}
	return b
}
