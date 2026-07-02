package payments

import "time"

type HealthEntry struct {
	Name      string     `json:"name"`
	Status    string     `json:"status"`
	Detail    string     `json:"detail"`
	LatencyMs int64      `json:"latency_ms,omitempty"`
	LastAt    *time.Time `json:"last_at,omitempty"`
}

type SystemHealth struct {
	GeneratedAt time.Time     `json:"generated_at"`
	Infra       []HealthEntry `json:"infra"`
	Business    []HealthEntry `json:"business"`
	Alerts      []HealthEntry `json:"alerts"`
	Overall     string        `json:"overall"`
}

// classifyAge: "unknown" (nil), "ok" (<=warn), "stale" (<=down), "error" (>down).
func classifyAge(last *time.Time, now time.Time, warnAfter, downAfter time.Duration) string {
	if last == nil {
		return "unknown"
	}
	age := now.Sub(*last)
	switch {
	case age <= warnAfter:
		return "ok"
	case age <= downAfter:
		return "stale"
	default:
		return "error"
	}
}

// overallStatus: worst-of across all entry groups.
func overallStatus(groups ...[]HealthEntry) string {
	hasWarn, hasKnown := false, false
	for _, g := range groups {
		for _, e := range g {
			switch e.Status {
			case "down", "error":
				return "down"
			case "warn", "stale":
				hasWarn, hasKnown = true, true
			case "unknown":
				// no-op
			default:
				hasKnown = true
			}
		}
	}
	if hasWarn {
		return "warn"
	}
	if !hasKnown {
		return "unknown"
	}
	return "ok"
}
