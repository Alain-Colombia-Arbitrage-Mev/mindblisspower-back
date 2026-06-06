package simulator

import (
	"math/rand"

	"github.com/shopspring/decimal"
)

// PlacementStrategy names a placement algorithm.
// Used by the CLI and the strategy comparison tool.
const (
	StrategyWeakLeg    = "weak-leg"
	StrategyRandom     = "random"
	StrategyAlwaysLeft = "always-left"
)

// PlaceWithStrategy inserts a new node under the given parent using the
// chosen algorithm. Returns the new node ID, or panics if strategy is unknown.
func PlaceWithStrategy(
	tree *Tree,
	parentID int64,
	price decimal.Decimal,
	strategy string,
	rng *rand.Rand,
) int64 {
	switch strategy {
	case "", StrategyWeakLeg:
		id, _, _ := tree.AutoPlace(parentID, price)
		return id
	case StrategyRandom:
		id, _, _ := tree.PlaceRandom(parentID, price, rng)
		return id
	case StrategyAlwaysLeft:
		id, _, _ := tree.PlaceAlwaysLeft(parentID, price)
		return id
	default:
		panic("unknown placement strategy: " + strategy)
	}
}

// PlaceRandom: at each level, pick L or R uniformly; descend if the chosen
// side is occupied; else place. Naive random doesn't balance, but it's a
// useful baseline to measure how much value weak-leg adds.
func (t *Tree) PlaceRandom(parentID int64, price decimal.Decimal, rng *rand.Rand) (int64, int64, string) {
	if _, ok := t.nodes[parentID]; !ok {
		panic("place_random: parent not in tree")
	}
	current := t.nodes[parentID]
	for {
		side := "L"
		if rng.Intn(2) == 1 {
			side = "R"
		}
		childID := current.LeftID
		if side == "R" {
			childID = current.RightID
		}
		if childID == 0 {
			return t.attach(current, side, parentID, price)
		}
		current = t.nodes[childID]
	}
}

// PlaceAlwaysLeft: pathological baseline. Always descends left, creating a
// degenerate chain. Used to confirm the binary plan produces $0 bonus under
// the worst-possible placement — the strict T7 anti-Ponzi test.
func (t *Tree) PlaceAlwaysLeft(parentID int64, price decimal.Decimal) (int64, int64, string) {
	if _, ok := t.nodes[parentID]; !ok {
		panic("place_always_left: parent not in tree")
	}
	current := t.nodes[parentID]
	for {
		if current.LeftID == 0 {
			return t.attach(current, "L", parentID, price)
		}
		current = t.nodes[current.LeftID]
	}
}

// attach creates the new node, links it, and updates ancestor counters
// (LeftCount/RightCount). Also propagates MaxDownlineDepth upward and records
// any depth-threshold crossings (ADR-0013 R1).
//
// Shared insertion path so all strategies maintain identical state.
func (t *Tree) attach(parent *Node, side string, sponsorID int64, price decimal.Decimal) (int64, int64, string) {
	t.nextID++
	id := t.nextID
	newNode := &Node{
		ID:                   id,
		ParentID:             parent.ID,
		Position:             side,
		SponsorID:            sponsorID,
		Depth:                parent.Depth + 1,
		PackagePrice:         price,
		Active:               true,
		Qualified:            true,
		LastPurchaseAt:       t.currentPeriod, // initial package counts as first purchase
		PackageDepositPeriod: t.currentPeriod, // for CapitalLockPeriods reporting
	}
	t.nodes[id] = newNode
	if side == "L" {
		parent.LeftID = id
	} else {
		parent.RightID = id
	}
	t.incrementCounts(id)
	t.propagateDownlineDepth(newNode)
	t.incrementSponsorDirects(newNode)
	return id, parent.ID, side
}

// incrementSponsorDirects walks from newNode up the binary tree to find its
// sponsor (SponsorID), then bumps DirectsLeft or DirectsRight on the sponsor
// depending on which subtree of the sponsor this node landed in.
// Used by R2 qualification (need ≥1 direct on each side for the 25% yield).
func (t *Tree) incrementSponsorDirects(newNode *Node) {
	if newNode.SponsorID == 0 {
		return
	}
	sponsor := t.nodes[newNode.SponsorID]
	if sponsor == nil {
		return
	}
	cur := newNode
	for cur != nil && cur.ParentID != 0 {
		if cur.ParentID == sponsor.ID {
			if sponsor.LeftID == cur.ID {
				sponsor.DirectsLeft++
			} else if sponsor.RightID == cur.ID {
				sponsor.DirectsRight++
			}
			return
		}
		cur = t.nodes[cur.ParentID]
	}
}

// propagateDownlineDepth walks from newNode up to root. For each ancestor A,
// the relative depth of newNode from A is (newNode.Depth - A.Depth). If that
// exceeds A.MaxDownlineDepth, update A. Also detect if A just crossed a
// multiple of RepurchaseThreshold (default 10) and record the period.
//
// The default threshold (10) is hard-coded here because Tree doesn't know
// the PlanConfig. If we ever need configurable thresholds, pass it in.
func (t *Tree) propagateDownlineDepth(newNode *Node) {
	const threshold = 10
	cur := newNode
	for cur.ParentID != 0 {
		anc := t.nodes[cur.ParentID]
		if anc == nil {
			return
		}
		relDepth := newNode.Depth - anc.Depth
		if relDepth > anc.MaxDownlineDepth {
			oldThreshold := (anc.MaxDownlineDepth / threshold) * threshold
			newThreshold := (relDepth / threshold) * threshold
			anc.MaxDownlineDepth = relDepth
			if newThreshold > oldThreshold {
				// Crossed a new multiple of 10 — record it.
				anc.LastDepthThresholdCrossed = newThreshold
				anc.LastDepthThresholdAt = t.currentPeriod
			}
		}
		cur = anc
	}
}
