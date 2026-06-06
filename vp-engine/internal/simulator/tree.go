// Package simulator runs a Monte Carlo solvency simulation of the binary
// compensation plan without touching the real database.
//
// Design constraint: this is a stationary-state stress test. ADR-0012 §3.7
// mandates that the plan be solvent even when growth = 0. If a scenario with
// growth = 0 makes the simulator report theta < 1 for many periods, the plan
// is by construction Ponzi-leaning and parameters must be re-tuned BEFORE
// shipping changes to plan_config.
package simulator

import (
	"math/rand"

	"github.com/shopspring/decimal"
)

// Node is an in-memory mirror of mlm.affiliate. Mutable.
type Node struct {
	ID         int64
	ParentID   int64 // 0 = root
	Position   string // "L" or "R" — own position under parent
	SponsorID  int64
	Depth      int
	LeftID     int64 // child IDs (0 = empty leg)
	RightID    int64
	// Running PV (decays each period via Carry/Block math).
	LeftPV     decimal.Decimal
	RightPV    decimal.Decimal
	LeftCarry  decimal.Decimal
	RightCarry decimal.Decimal
	// Subtree size counters for placement balance (tie-break in weakLeg).
	LeftCount  int64
	RightCount int64
	// R1 — depth-based repurchase rule (ADR-0013).
	// MaxDownlineDepth = how many levels below this node the deepest
	// descendant sits (0 if leaf, else delta from this node's depth).
	MaxDownlineDepth int
	// LastDepthThresholdCrossed = highest multiple of 10 that MaxDownlineDepth
	// has reached (0, 10, 20, ...). When MaxDownlineDepth grows past 10
	// for the first time this becomes 10; past 20 → 20, etc.
	LastDepthThresholdCrossed int
	// LastDepthThresholdAt = period number when LastDepthThresholdCrossed
	// was last updated. Used by isQualifiedR1.
	LastDepthThresholdAt int
	// LastPurchaseAt = period number of the most recent package purchase.
	// Initialized to the period the node was created (counts as first
	// purchase). Bumped each time the affiliate complies with a repurchase.
	LastPurchaseAt int
	// P-B paused carry: bonuses computed but withheld pending compliance.
	// Released to wallet (subject to θ + caps) at next compliant period.
	// Expires after PausedCarryDecayPeriods of no compliance.
	PausedCarry          decimal.Decimal
	PausedCarryUpdatedAt int // period when PausedCarry was last touched
	// Package value attributed to this affiliate. For per-package cap (T2).
	PackagePrice  decimal.Decimal
	PackagePaid   decimal.Decimal
	PackageClosed bool
	// Daily/period paid total (for T3 daily cap).
	PeriodPaid decimal.Decimal
	Qualified  bool
	Active     bool

	// R2 — direct-sponsorship counters split by binary side. A "direct"
	// is a node whose SponsorID = this node. DirectsLeft counts those
	// placed in this node's left subtree, DirectsRight those in the right.
	// Used to gate the 25% annual yield (needs ≥1 on each side).
	DirectsLeft  int
	DirectsRight int

	// Capital lock — period when the package was deposited. Capital is
	// considered locked while (currentPeriod - PackageDepositPeriod) <
	// Plan.CapitalLockPeriods. Reported for liquidity, not solvency.
	PackageDepositPeriod int

	// R3 points bonus accrual. Bumped each time a block pays out to this
	// node. Cleared at the end of each PointsCadencePeriods after payout.
	PointsAccrued decimal.Decimal

	// Carrera de rangos (ADR-0017/0018): puntos acumulados DE POR VIDA por
	// pierna. A diferencia de LeftPV/RightPV, NO se consumen con los bloques.
	// Calificación del rango N: min(LeftPVLifetime, RightPVLifetime) ≥
	// RankDefs[N].PointsEachSide. (Migrados 2.0: arrancan en 0 + baseline,
	// el simulador modela cohortes nuevas → baseline 0.)
	LeftPVLifetime  decimal.Decimal
	RightPVLifetime decimal.Decimal
	// Índice 1-based del mayor rango alcanzado en Plan.RankDefs. 0 = ninguno.
	// One-time: nunca decrece; el bono de cada hito se paga una sola vez.
	RankAchieved int

	// Fundadores (ADR-0018): cohorte de lanzamiento v2.0. Su binario paga
	// FounderBinaryMatchedRate × matched (en vez de $/bloque) y su referido
	// usa FounderReferralRate.
	IsFounder bool
}

// Tree holds the binary forest with a single root.
// For simplicity we model one connected binary tree (one company root).
type Tree struct {
	nodes         map[int64]*Node
	nextID        int64
	rng           *rand.Rand
	currentPeriod int // updated by RunScenario; used by attach() for R1 timestamps
}

// SetPeriod is called by RunScenario at the start of each period so the
// tree can stamp new placements + threshold crossings with the right time.
func (t *Tree) SetPeriod(p int) { t.currentPeriod = p }

// NewTree creates an empty tree with seed-driven randomness.
func NewTree(seed int64) *Tree {
	return &Tree{
		nodes:  make(map[int64]*Node),
		nextID: 0,
		rng:    rand.New(rand.NewSource(seed)),
	}
}

// Seed exposes the underlying RNG for use by the scenario layer.
func (t *Tree) Seed() *rand.Rand { return t.rng }

// AllNodesSorted returns all non-root nodes in deterministic id order.
// Useful for external analyzers; internal code should keep using allNodes().
func (t *Tree) AllNodesSorted() []*Node {
	out := make([]*Node, 0, len(t.nodes))
	for _, n := range t.nodes {
		if n.ParentID == 0 {
			continue
		}
		out = append(out, n)
	}
	sortNodesByID(out)
	return out
}

// Size returns the number of nodes in the tree.
func (t *Tree) Size() int { return len(t.nodes) }

// Get returns the node by id (or nil).
func (t *Tree) Get(id int64) *Node { return t.nodes[id] }

// CreateRoot inserts the company root node. Returns its ID.
// Root has no parent and no sponsor; its PackagePrice is zero.
func (t *Tree) CreateRoot() int64 {
	t.nextID++
	id := t.nextID
	t.nodes[id] = &Node{
		ID:        id,
		ParentID:  0,
		Position:  "",
		SponsorID: 0,
		Depth:     0,
		Active:    true,
		Qualified: true,
	}
	return id
}

// AutoPlace inserts a new node under sponsor following the weak-leg rule.
// This is the in-memory mirror of app/src/server/affiliate.ts:autoPlaceAffiliate.
//
// Returns the new node ID and the chosen (parentID, side).
func (t *Tree) AutoPlace(sponsorID int64, packagePrice decimal.Decimal) (int64, int64, string) {
	if _, ok := t.nodes[sponsorID]; !ok {
		panic("auto_place: sponsor not in tree")
	}
	current := t.nodes[sponsorID]
	for {
		side := t.weakLeg(current)
		childID := current.LeftID
		if side == "R" {
			childID = current.RightID
		}
		if childID == 0 {
			return t.attach(current, side, sponsorID, packagePrice)
		}
		current = t.nodes[childID]
	}
}

// incrementCounts walks from the just-inserted node up to root and bumps
// the appropriate side counter on every ancestor.
func (t *Tree) incrementCounts(insertedID int64) {
	child := t.nodes[insertedID]
	for child != nil && child.ParentID != 0 {
		parent := t.nodes[child.ParentID]
		if parent == nil {
			break
		}
		if parent.LeftID == child.ID {
			parent.LeftCount++
		} else if parent.RightID == child.ID {
			parent.RightCount++
		}
		child = parent
	}
}

// weakLeg picks the leg with less running PV, with subtree-count tie-break
// (so before any PV exists, placements still balance the tree). Mirrors
// app/src/server/affiliate.ts:weakerOf().
func (t *Tree) weakLeg(n *Node) string {
	if n.LeftPV.LessThan(n.RightPV) {
		return "L"
	}
	if n.RightPV.LessThan(n.LeftPV) {
		return "R"
	}
	if n.LeftCount < n.RightCount {
		return "L"
	}
	if n.RightCount < n.LeftCount {
		return "R"
	}
	return "L"
}

// Ancestors returns the ancestor chain up to maxDepth (excluding self).
// Order: closest ancestor first, root last. Used by the bonus engine.
func (t *Tree) Ancestors(id int64, maxDepth int) []*Node {
	out := make([]*Node, 0, maxDepth)
	cur := t.nodes[id]
	for i := 0; i < maxDepth && cur != nil && cur.ParentID != 0; i++ {
		cur = t.nodes[cur.ParentID]
		if cur == nil {
			break
		}
		out = append(out, cur)
	}
	return out
}

// AddPV credits PV to the appropriate side of every ancestor up to maxDepth.
// "Side" from ancestor's perspective: if the event came through ancestor's
// left subtree, increment LeftPV; else RightPV. Determined by walking from
// event node up: each step records on the side we came from.
//
// Los puntos de CARRERA (LeftPVLifetime/RightPVLifetime) se acreditan a
// TODOS los ancestros sin límite de profundidad — espejo del trigger
// trg_apply_tree_event en producción (propaga por path completo). El
// DepthCap sólo limita el PV del binario (pagos), no la carrera.
func (t *Tree) AddPV(eventNodeID int64, pv decimal.Decimal, maxDepth int) {
	child := t.nodes[eventNodeID]
	for i := 0; child != nil && child.ParentID != 0; i++ {
		parent := t.nodes[child.ParentID]
		if parent == nil {
			break
		}
		withinCap := i < maxDepth
		if parent.LeftID == child.ID {
			if withinCap {
				parent.LeftPV = parent.LeftPV.Add(pv)
			}
			parent.LeftPVLifetime = parent.LeftPVLifetime.Add(pv)
		} else if parent.RightID == child.ID {
			if withinCap {
				parent.RightPV = parent.RightPV.Add(pv)
			}
			parent.RightPVLifetime = parent.RightPVLifetime.Add(pv)
		}
		child = parent
	}
}
