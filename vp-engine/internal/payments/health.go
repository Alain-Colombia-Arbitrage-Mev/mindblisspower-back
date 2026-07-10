package payments

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

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

// GetSystemHealth: cada check en su bloque, error => entrada degradada (nunca panic).
// siblings: map de nombre → URL base (p.ej. "web" → "http://127.0.0.1:3000/").
func (s *Store) GetSystemHealth(ctx context.Context, siblings map[string]string) SystemHealth {
	now := time.Now().UTC()
	sh := SystemHealth{GeneratedAt: now}

	// --- INFRA: RDS ping ---
	{
		t0 := time.Now()
		var one int
		err := s.reader().QueryRow(ctx, "SELECT 1").Scan(&one)
		e := HealthEntry{Name: "rds", LatencyMs: time.Since(t0).Milliseconds()}
		if err != nil {
			e.Status, e.Detail = "down", err.Error()
		} else {
			e.Status, e.Detail = "up", "SELECT 1 ok"
		}
		sh.Infra = append(sh.Infra, e)
	}
	// --- INFRA: servicios hermanos vía /health ---
	for _, name := range []string{"web", "vp-engine", "vp-payments"} {
		url := siblings[name]
		if url == "" {
			sh.Infra = append(sh.Infra, HealthEntry{Name: name, Status: "unknown", Detail: "no url"})
			continue
		}
		sh.Infra = append(sh.Infra, pingHealth(ctx, name, url))
	}

	// --- BUSINESS: último devengo ROI (wallet_movement concept 1006).
	// Nota: usamos posted_at (columna de negocio indexada) en vez de created_at.
	sh.Business = append(sh.Business, s.checkLastAt(ctx, "roi_accrual",
		"SELECT max(posted_at) FROM mlm.wallet_movement WHERE concept_id = 1006",
		now, 26*time.Hour, 50*time.Hour, "último devengo ROI"))

	// --- BUSINESS: período binario abierto ---
	{
		e := HealthEntry{Name: "binary_period"}
		var id int64
		var status string
		err := s.reader().QueryRow(ctx,
			"SELECT id, status::text FROM mlm.binary_period WHERE status = 'open' ORDER BY id DESC LIMIT 1").Scan(&id, &status)
		if err != nil {
			e.Status, e.Detail = "warn", "sin período abierto"
		} else {
			e.Status, e.Detail = "ok", fmt.Sprintf("período #%d %s", id, status)
		}
		sh.Business = append(sh.Business, e)
	}

	// --- BUSINESS: webhooks Stripe 24h ---
	{
		e := HealthEntry{Name: "stripe_webhooks_24h"}
		var n int64
		err := s.reader().QueryRow(ctx,
			"SELECT count(*) FROM payments.stripe_event WHERE received_at >= now() - interval '24 hours'").Scan(&n)
		if err != nil {
			e.Status, e.Detail = "unknown", err.Error()
		} else {
			e.Status, e.Detail = "ok", fmt.Sprintf("%d eventos 24h", n)
		}
		sh.Business = append(sh.Business, e)
	}

	// --- BUSINESS: pg_cron jobs (partman) ---
	{
		e := HealthEntry{Name: "pg_cron"}
		var n int64
		err := s.reader().QueryRow(ctx, "SELECT count(*) FROM cron.job").Scan(&n)
		if err != nil {
			// cron.job puede no existir o no ser accesible desde este rol DB → degradar
			e.Status, e.Detail = "unknown", err.Error()
		} else {
			e.Status, e.Detail = "ok", fmt.Sprintf("%d jobs", n)
		}
		sh.Business = append(sh.Business, e)
	}

	// --- ALERTS: abiertas ---
	{
		rows, err := s.reader().Query(ctx,
			"SELECT signal, severity, detail FROM mlm.alert_event WHERE status='open' ORDER BY created_at DESC LIMIT 20")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var sig, sev, det string
				if rows.Scan(&sig, &sev, &det) == nil {
					st := "warn"
					if sev == "critical" {
						st = "down"
					}
					sh.Alerts = append(sh.Alerts, HealthEntry{Name: sig, Status: st, Detail: det})
				}
			}
			if rerr := rows.Err(); rerr != nil {
				sh.Alerts = append(sh.Alerts, HealthEntry{Name: "alerts", Status: "unknown", Detail: rerr.Error()})
			}
		}
		// si err != nil o no hay filas, sh.Alerts queda vacío (degradación silenciosa)
	}

	sh.Overall = overallStatus(sh.Infra, sh.Business, sh.Alerts)
	return sh
}

// checkLastAt: corre un query "SELECT max(ts)" y clasifica por edad.
func (s *Store) checkLastAt(ctx context.Context, name, query string, now time.Time, warn, down time.Duration, label string) HealthEntry {
	e := HealthEntry{Name: name}
	var last *time.Time
	if err := s.reader().QueryRow(ctx, query).Scan(&last); err != nil {
		e.Status, e.Detail = "unknown", err.Error()
		return e
	}
	e.LastAt = last
	e.Status = classifyAge(last, now, warn, down)
	if last == nil {
		e.Detail = label + ": sin registros"
	} else {
		e.Detail = fmt.Sprintf("%s: %s", label, last.Format(time.RFC3339))
	}
	return e
}

// pingHealth: GET url con timeout corto; up si 2xx.
func pingHealth(ctx context.Context, name, url string) HealthEntry {
	e := HealthEntry{Name: name}
	cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	t0 := time.Now()
	req, rerr := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if rerr != nil {
		e.Status, e.Detail = "down", rerr.Error()
		return e
	}
	resp, err := http.DefaultClient.Do(req)
	e.LatencyMs = time.Since(t0).Milliseconds()
	if err != nil {
		e.Status, e.Detail = "down", err.Error()
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		e.Status, e.Detail = "up", fmt.Sprintf("HTTP %d", resp.StatusCode)
	} else {
		e.Status, e.Detail = "warn", fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return e
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
