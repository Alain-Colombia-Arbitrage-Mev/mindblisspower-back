package simulator

import (
	"math"
	"sort"
)

// TreeStats aggregates shape metrics. All metrics exclude the root node so
// they describe the affiliate tree as users perceive it (root = company).
type TreeStats struct {
	NodeCount       int     // excl. root
	MaxDepth        int     // longest root-to-leaf path
	MeanDepth       float64 // average depth across all nodes
	IdealDepth      float64 // ceil(log2(N+1)) — lower bound for any binary tree
	DepthInflation  float64 // MaxDepth / IdealDepth — 1.0 = perfectly balanced
	DepthHistogram  []int   // index = depth, value = count
	EmptyLegRate    float64 // fraction of internal nodes with at least one empty child slot
	BothEmptyRate   float64 // fraction of internal nodes that are leaves (both empty)
	MedianSkew      float64 // median of |L-R| / (L+R+1) over internal nodes
	MaxSkew         float64 // worst case |L-R| / (L+R+1) over internal nodes
	GiniSubtreeSize float64 // Gini coefficient of subtree sizes (inequality of attention)
	LeftRightRatio  float64 // global Σ LeftCount / Σ (LeftCount+RightCount)
}

// ComputeStats walks the tree once (O(n)) and returns the shape report.
func ComputeStats(tree *Tree, rootID int64) TreeStats {
	var s TreeStats
	if tree == nil {
		return s
	}

	depthSum := 0
	depthBuckets := map[int]int{}
	internalWithEmpty := 0
	internalNoChildren := 0
	totalInternal := 0
	skews := make([]float64, 0, tree.Size())
	subtreeSizes := make([]float64, 0, tree.Size())
	var leftSum, rightSum int64

	for id, n := range tree.nodes {
		if id == rootID {
			continue
		}
		s.NodeCount++
		depthSum += n.Depth
		depthBuckets[n.Depth]++

		hasL := n.LeftID != 0
		hasR := n.RightID != 0
		totalInternal++
		if !hasL || !hasR {
			internalWithEmpty++
		}
		if !hasL && !hasR {
			internalNoChildren++
		}

		// Skew on internal nodes only (a leaf trivially has skew 0/1=0; we
		// don't want a forest of leaves to drag the median down).
		if hasL || hasR {
			l := float64(n.LeftCount)
			r := float64(n.RightCount)
			skew := math.Abs(l-r) / (l + r + 1)
			skews = append(skews, skew)
		}

		// Subtree size for Gini (root not included).
		subtreeSizes = append(subtreeSizes, float64(n.LeftCount+n.RightCount+1))

		leftSum += n.LeftCount
		rightSum += n.RightCount

		if n.Depth > s.MaxDepth {
			s.MaxDepth = n.Depth
		}
	}

	if s.NodeCount > 0 {
		s.MeanDepth = float64(depthSum) / float64(s.NodeCount)
		s.IdealDepth = math.Ceil(math.Log2(float64(s.NodeCount + 1)))
		if s.IdealDepth > 0 {
			s.DepthInflation = float64(s.MaxDepth) / s.IdealDepth
		}
	}

	s.DepthHistogram = make([]int, s.MaxDepth+1)
	for d, c := range depthBuckets {
		s.DepthHistogram[d] = c
	}

	if totalInternal > 0 {
		s.EmptyLegRate = float64(internalWithEmpty) / float64(totalInternal)
		s.BothEmptyRate = float64(internalNoChildren) / float64(totalInternal)
	}

	if len(skews) > 0 {
		sort.Float64s(skews)
		s.MedianSkew = skews[len(skews)/2]
		s.MaxSkew = skews[len(skews)-1]
	}

	if total := leftSum + rightSum; total > 0 {
		s.LeftRightRatio = float64(leftSum) / float64(total)
	}

	s.GiniSubtreeSize = gini(subtreeSizes)

	return s
}

// gini computes the Gini coefficient of a non-negative slice. 0 = perfect
// equality, 1 = perfect inequality (one element owns everything).
func gini(xs []float64) float64 {
	n := len(xs)
	if n == 0 {
		return 0
	}
	sorted := make([]float64, n)
	copy(sorted, xs)
	sort.Float64s(sorted)
	var num, denom float64
	for i, x := range sorted {
		num += float64(2*(i+1)-n-1) * x
		denom += x
	}
	if denom == 0 {
		return 0
	}
	return num / (float64(n) * denom)
}
