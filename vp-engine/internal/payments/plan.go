package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// simKeyMap traduce campos del editor (columnas plan_config) a las claves de
// override que entiende el simulador Monte Carlo del motor (internal/simulate).
// Lo que no esté aquí no lo modela el simulador binario (lo cubre la proyección
// forward: ROI/referido/regalía).
var simKeyMap = map[string]string{
	"treasury_alpha":              "treasury_alpha",
	"lifetime_cap_factor":         "lifetime_cap_factor",
	"daily_cap_factor":            "daily_cap_factor",
	"founder_binary_matched_rate": "founder_rate",
	"rank_installments":           "rank_installments",
	"rank_installment_cadence":    "rank_cadence",
}

// engineSimulateTheta llama al simulador canónico del motor (POST /simulate) con
// los overrides propuestos que el simulador binario modela. Devuelve el peor θ
// observado + si es solvente, y ran=false si el motor no aplica/está inalcanzable
// (en cuyo caso NO se bloquea por el canónico — el forward sigue gobernando).
func (s *Store) engineSimulateTheta(ctx context.Context, changes map[string]any) (worstTheta float64, solvent, ran bool) {
	if s.EngineURL == "" {
		return 0, true, false
	}
	ov := map[string]string{}
	for editorKey, simKey := range simKeyMap {
		if v, ok := changes[editorKey]; ok {
			ov[simKey] = fmt.Sprintf("%v", v)
		}
	}
	if len(ov) == 0 {
		return 0, true, false // el cambio no toca nada que el simulador binario modele
	}
	body, _ := json.Marshal(map[string]any{"overrides": ov, "periods": 52, "seed": 42})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.EngineURL, "/")+"/simulate", bytes.NewReader(body))
	if err != nil {
		return 0, true, false
	}
	req.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, true, false // motor inalcanzable → no bloquear por el canónico
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, true, false
	}
	var out struct {
		WorstTheta float64 `json:"worst_theta"`
		Solvent    bool    `json:"solvent"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, true, false
	}
	return out.WorstTheta, out.Solvent && out.WorstTheta >= SolvencyThetaFloor, true
}

// planEditableFields: campos de mlm.plan_config que un admin puede cambiar por
// four-eyes, con su tipo de cast SQL (para overridear desde el payload jsonb).
// Lo NO listado (version_label, effective_*, ids) lo maneja la publicación.
var planEditableFields = []struct{ Key, Cast string }{
	{"treasury_alpha", "numeric"}, {"block_size", "int"}, {"bonus_per_block", "numeric"},
	{"depth_cap", "int"}, {"daily_cap_factor", "numeric"}, {"lifetime_cap_factor", "numeric"},
	{"period_cap_factor", "numeric"}, {"carry_decay_days", "int"},
	{"qualified_directs_left", "smallint"}, {"qualified_directs_right", "smallint"},
	{"yield_enabled", "boolean"}, {"yield_annual_rate", "numeric"}, {"yield_cadence_periods", "int"}, {"capital_lock_periods", "int"},
	{"points_enabled", "boolean"}, {"points_per_block", "numeric"}, {"points_dollars_per_point", "numeric"}, {"points_cadence_periods", "int"},
	{"ranks_enabled", "boolean"}, {"rank_installments", "int"}, {"rank_installment_cadence", "int"},
	{"royalty_enabled", "boolean"}, {"royalty_rate", "numeric"}, {"royalty_generation", "int"}, {"referral_rate", "numeric"},
	{"founder_enrollment_open", "boolean"}, {"founder_referral_rate", "numeric"}, {"founder_binary_matched_rate", "numeric"},
	{"cd_lock_days", "int"}, {"cd_qualified_directs", "int"}, {"cd_same_tier_required", "boolean"},
	{"pause_mode", "text"}, {"pause_reduction_factor", "numeric"}, {"depth_repurchase_enabled", "boolean"},
	{"repurchase_threshold", "int"}, {"purchase_stale_periods", "int"}, {"paused_carry_decay_periods", "int"}, {"renewal_cost_factor", "numeric"},
	{"retirement_age", "int"}, {"retirement_early_penalty", "numeric"}, {"directs_active_required", "boolean"},
}

// planBounds: cotas de cordura para campos numéricos sensibles (defensa básica;
// la verdadera validación de solvencia θ es vía simulación — follow-up).
var planBounds = map[string][2]float64{
	"treasury_alpha":              {0.30, 0.60}, // ADR-0012 rango operativo de α
	"depth_cap":                   {1, 30},
	"lifetime_cap_factor":         {1.0, 5.0},
	"daily_cap_factor":            {0.5, 10.0},
	"bonus_per_block":             {1, 1000},
	"block_size":                  {50, 5000},
	"royalty_rate":                {0, 0.5},
	"referral_rate":               {0, 0.5},
	"founder_referral_rate":       {0, 0.5},
	"founder_binary_matched_rate": {0, 0.5},
	"yield_annual_rate":           {0, 1.0},
	"retirement_early_penalty":    {0, 1.0},
	"pause_reduction_factor":      {0, 1.0},
}

var (
	ErrPlanFieldNotEditable = errors.New("campo no editable")
	ErrPlanFieldOutOfBounds = errors.New("valor fuera de rango")
	ErrApproverIsInitiator  = errors.New("el aprobador no puede ser el proponente (four-eyes)")
	ErrProposalNotPending   = errors.New("la propuesta no está pendiente")
	ErrSolvencyLock         = errors.New("lock de solvencia: θ proyectado < 0.85, el cambio dejaría la red insolvente")
)

// SolvencyThetaFloor: piso de θ para publicar un cambio de comisiones. Si la
// simulación proyecta θ por debajo, el publish se bloquea (ADR-0012: la red no
// debe poder configurarse hacia la insolvencia).
const SolvencyThetaFloor = 0.85

// inflowsWindowDays: ventana para anualizar inflows reales en la simulación.
const inflowsWindowDays = 30

func planFieldEditable(k string) bool {
	for _, f := range planEditableFields {
		if f.Key == k {
			return true
		}
	}
	return false
}

// GetActivePlanConfig devuelve la config de comisiones vigente (solo los campos
// editables + meta) como JSON, lista para mostrar/editar en el panel.
func (s *Store) GetActivePlanConfig(ctx context.Context) (json.RawMessage, error) {
	sel := "version_label, to_char(effective_from,'YYYY-MM-DD') AS effective_from"
	for _, f := range planEditableFields {
		sel += ", " + f.Key
	}
	var js []byte
	err := s.db.QueryRow(ctx, `SELECT row_to_json(t) FROM (
		SELECT `+sel+` FROM mlm.plan_config
		 WHERE effective_to IS NULL OR effective_to > now()
		 ORDER BY effective_from DESC LIMIT 1) t`).Scan(&js)
	if errors.Is(err, pgx.ErrNoRows) {
		return json.RawMessage(`null`), nil
	}
	if err != nil {
		return nil, fmt.Errorf("active plan_config: %w", err)
	}
	return js, nil
}

// ProposePlanChange registra una propuesta de cambio (approval_request,
// operation_type='plan_config_publish') con los campos cambiados en el payload.
// Valida whitelist + cotas. NO aplica nada: requiere un 2º admin que apruebe.
func (s *Store) ProposePlanChange(ctx context.Context, adminEmail string, changes map[string]any, reason string) (int64, error) {
	if len(changes) == 0 {
		return 0, fmt.Errorf("sin cambios")
	}
	if len(strings.TrimSpace(reason)) < 10 {
		return 0, fmt.Errorf("la razón debe tener al menos 10 caracteres")
	}
	for k, v := range changes {
		if !planFieldEditable(k) {
			return 0, fmt.Errorf("%w: %s", ErrPlanFieldNotEditable, k)
		}
		if b, ok := planBounds[k]; ok {
			if f, ok := toFloat(v); ok && (f < b[0] || f > b[1]) {
				return 0, fmt.Errorf("%w: %s=%v (rango %.2f–%.2f)", ErrPlanFieldOutOfBounds, k, v, b[0], b[1])
			}
		}
	}
	var personID int64
	if err := s.db.QueryRow(ctx, `SELECT id FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`, adminEmail).Scan(&personID); err != nil {
		return 0, fmt.Errorf("initiator person: %w", err)
	}
	payload, err := json.Marshal(changes)
	if err != nil {
		return 0, err
	}
	var reqID int64
	if err := s.db.QueryRow(ctx, `
		INSERT INTO mlm.approval_request
		  (operation_type, payload, requires_n_approvers, initiator_person_id, initiator_reason)
		VALUES ('plan_config_publish', $1::jsonb, 1, $2, $3)
		RETURNING id`, string(payload), personID, reason).Scan(&reqID); err != nil {
		return 0, fmt.Errorf("create approval request: %w", err)
	}
	return reqID, nil
}

// PlanSimulation es el resultado de proyectar θ bajo una config propuesta.
type PlanSimulation struct {
	Theta             float64 `json:"theta"`
	TreasuryAlpha     float64 `json:"treasury_alpha"`
	InflowsWindowUSD  float64 `json:"inflows_window_usd"`
	RoiObligationUSD  float64 `json:"roi_obligation_usd"`   // ROI de CDs activos, prorrateado a la ventana
	BonusObligationUSD float64 `json:"bonus_obligation_usd"` // referido+regalía sobre inflows de la ventana
	ProjectedOutflows float64 `json:"projected_outflows_usd"`
	Floor             float64 `json:"floor"`
	Solvent           bool    `json:"solvent"` // forward Y canónico (si corrió) ≥ floor
	Note              string  `json:"note"`
	// Canónico: simulador Monte Carlo del plan binario (motor). Solo corre si el
	// cambio toca α/caps/fundador y el motor está accesible.
	CanonicalRan     bool    `json:"canonical_ran"`
	CanonicalTheta   float64 `json:"canonical_worst_theta"`
	CanonicalSolvent bool    `json:"canonical_solvent"`
}

// SimulatePlanTheta proyecta θ bajo la config resultante de aplicar `changes`
// sobre la activa. Modelo (aprox., "CD para todos", binary close OFF):
//
//	θ = clamp( α × inflows_ventana / (roi_obligación + bonos_obligación) , 0, 1 )
//
// inflows  = compras reales (payments.purchase_intent paid|activated) en la ventana.
// roi_obl  = Σ principal × tasa_efectiva (calificada/base) de CDs activos × ventana/365.
// bono_obl = inflows × (max(referral,founder_referral) + royalty)  — referido+regalía.
// El binario se omite del estimado (lo acotan θ/T2/T3 cuando corra). Es un guard
// de solvencia sobre la generosidad del plan, no el θ canónico del cierre binario.
func (s *Store) SimulatePlanTheta(ctx context.Context, changes map[string]any) (PlanSimulation, error) {
	sim := PlanSimulation{Floor: SolvencyThetaFloor}

	// Rates de la config activa (con override de los cambios propuestos).
	var alpha, refRate, founderRef, royalty float64
	err := s.db.QueryRow(ctx, `
		SELECT treasury_alpha::float8, referral_rate::float8, founder_referral_rate::float8, royalty_rate::float8
		  FROM mlm.plan_config
		 WHERE effective_to IS NULL OR effective_to > now()
		 ORDER BY effective_from DESC LIMIT 1`).Scan(&alpha, &refRate, &founderRef, &royalty)
	if errors.Is(err, pgx.ErrNoRows) {
		sim.Theta = 1
		sim.Note = "no hay config activa; simulación no concluyente"
		sim.Solvent = true
		return sim, nil
	}
	if err != nil {
		return sim, fmt.Errorf("active rates: %w", err)
	}
	if v, ok := toFloat(changes["treasury_alpha"]); ok {
		alpha = v
	}
	if v, ok := toFloat(changes["referral_rate"]); ok {
		refRate = v
	}
	if v, ok := toFloat(changes["founder_referral_rate"]); ok {
		founderRef = v
	}
	if v, ok := toFloat(changes["royalty_rate"]); ok {
		royalty = v
	}
	sim.TreasuryAlpha = alpha

	// Inflows reales en la ventana.
	if err := s.db.QueryRow(ctx, fmt.Sprintf(`
		SELECT COALESCE(SUM(amount_usd),0)::float8
		  FROM payments.purchase_intent
		 WHERE status IN ('paid','activated')
		   AND created_at >= now() - interval '%d days'`, inflowsWindowDays)).Scan(&sim.InflowsWindowUSD); err != nil {
		return sim, fmt.Errorf("inflows: %w", err)
	}

	// Obligación ROI: CDs activos × tasa efectiva, prorrateada a la ventana.
	if err := s.db.QueryRow(ctx, fmt.Sprintf(`
		SELECT COALESCE(SUM(
		         cd.principal_usd *
		         CASE WHEN COALESCE(q.qualifies_uplift,false) THEN t.qualified_annual_rate ELSE t.base_annual_rate END
		       ),0)::float8 * (%d.0/365.0)
		  FROM mlm.investment_cd cd
		  JOIN mlm.cd_roi_tier t ON t.id = cd.roi_tier_id
		  LEFT JOIN mlm.v_cd_qualification q ON q.investment_cd_id = cd.id
		 WHERE cd.status='active'`, inflowsWindowDays)).Scan(&sim.RoiObligationUSD); err != nil {
		return sim, fmt.Errorf("roi obligation: %w", err)
	}

	refComponent := refRate
	if founderRef > refComponent {
		refComponent = founderRef
	}
	sim.BonusObligationUSD = sim.InflowsWindowUSD * (refComponent + royalty)
	sim.ProjectedOutflows = sim.RoiObligationUSD + sim.BonusObligationUSD

	switch {
	case sim.InflowsWindowUSD <= 0:
		sim.Theta = 1
		sim.Note = fmt.Sprintf("sin inflows en los últimos %d días; simulación no concluyente (cambio permitido)", inflowsWindowDays)
	case sim.ProjectedOutflows <= 0:
		sim.Theta = 1
		sim.Note = "sin obligaciones proyectadas; θ=1"
	default:
		t := alpha * sim.InflowsWindowUSD / sim.ProjectedOutflows
		if t > 1 {
			t = 1
		}
		sim.Theta = t
		sim.Note = fmt.Sprintf("θ proyectado bajo el modelo CD; piso de publicación %.2f", SolvencyThetaFloor)
	}
	sim.Solvent = sim.Theta >= SolvencyThetaFloor

	// Capa canónica: simulador Monte Carlo del plan binario (motor). Puede vetar.
	if ct, cs, ran := s.engineSimulateTheta(ctx, changes); ran {
		sim.CanonicalRan = true
		sim.CanonicalTheta = ct
		sim.CanonicalSolvent = cs
		if !cs {
			sim.Solvent = false
		}
		sim.Note += fmt.Sprintf(" · canónico (motor): peor θ=%.4f %s", ct, map[bool]string{true: "✓", false: "✗"}[cs])
	}
	return sim, nil
}

// PlanProposal es una fila del listado de propuestas de cambio de plan.
type PlanProposal struct {
	ID            int64           `json:"id"`
	Status        string          `json:"status"`
	Initiator     string          `json:"initiator"`
	InitiatorRzn  string          `json:"initiator_reason"`
	Payload       json.RawMessage `json:"payload"`
	Approver      string          `json:"approver,omitempty"`
	ApproverRzn   string          `json:"approver_reason,omitempty"`
	CreatedAt     string          `json:"created_at"`
}

// ListPlanProposals lista las propuestas de cambio de comisiones (recientes).
func (s *Store) ListPlanProposals(ctx context.Context) ([]PlanProposal, error) {
	rows, err := s.db.Query(ctx, `
		SELECT ar.id, ar.status::text,
		       COALESCE(trim(ip.first_name||' '||ip.last_name), ''),
		       ar.initiator_reason, ar.payload,
		       COALESCE(trim(ap.first_name||' '||ap.last_name), ''),
		       COALESCE(ar.approver_1_reason, ''),
		       to_char(ar.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM mlm.approval_request ar
		  JOIN mlm.person ip ON ip.id = ar.initiator_person_id
		  LEFT JOIN mlm.person ap ON ap.id = ar.approver_1_person_id
		 WHERE ar.operation_type = 'plan_config_publish'
		 ORDER BY ar.created_at DESC LIMIT 50`)
	if err != nil {
		return nil, fmt.Errorf("list proposals: %w", err)
	}
	defer rows.Close()
	out := []PlanProposal{}
	for rows.Next() {
		var p PlanProposal
		if err := rows.Scan(&p.ID, &p.Status, &p.Initiator, &p.InitiatorRzn, &p.Payload,
			&p.Approver, &p.ApproverRzn, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DecidePlanProposal: un 2º admin aprueba/rechaza. Al aprobar (four-eyes: el
// trigger avanza a 'approved'), publica la nueva config y marca 'executed'.
func (s *Store) DecidePlanProposal(ctx context.Context, adminEmail string, reqID int64, approve bool, reason string) (string, error) {
	var approverID int64
	if err := s.db.QueryRow(ctx, `SELECT id FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`, adminEmail).Scan(&approverID); err != nil {
		return "", fmt.Errorf("approver person: %w", err)
	}
	decision := "reject"
	if approve {
		decision = "approve"
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var status string
	err = tx.QueryRow(ctx, `
		UPDATE mlm.approval_request
		   SET approver_1_person_id = $2, approver_1_decision = $3,
		       approver_1_reason = $4, approver_1_at = now()
		 WHERE id = $1 AND operation_type='plan_config_publish' AND status='pending'
		RETURNING status::text`, reqID, approverID, decision, reason).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrProposalNotPending
	}
	if err != nil {
		// El constraint approval_initiator_not_approver_1 → el proponente no puede aprobar.
		if strings.Contains(err.Error(), "approval_initiator_not_approver") {
			return "", ErrApproverIsInitiator
		}
		return "", fmt.Errorf("decide proposal: %w", err)
	}

	if status == "approved" && approve {
		// Lock de solvencia: simular θ bajo la config propuesta antes de publicar.
		var payload map[string]any
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT payload FROM mlm.approval_request WHERE id=$1`, reqID).Scan(&raw); err != nil {
			return "", fmt.Errorf("read payload: %w", err)
		}
		_ = json.Unmarshal(raw, &payload)
		sim, serr := s.SimulatePlanTheta(ctx, payload)
		if serr != nil {
			return "", fmt.Errorf("simulate: %w", serr)
		}
		if !sim.Solvent {
			return "", fmt.Errorf("%w (θ=%.4f < %.2f, inflows=%.2f, obligaciones=%.2f)",
				ErrSolvencyLock, sim.Theta, sim.Floor, sim.InflowsWindowUSD, sim.ProjectedOutflows)
		}
		if err := executePlanPublish(ctx, tx, reqID, approverID); err != nil {
			return "", fmt.Errorf("publish: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE mlm.approval_request SET status='executed', executed_at=now() WHERE id=$1`, reqID); err != nil {
			return "", fmt.Errorf("mark executed: %w", err)
		}
		status = "executed"
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return status, nil
}

// executePlanPublish copia la config activa, overridea los campos del payload y
// la inserta como nueva versión vigente (cerrando la anterior). En un solo
// statement vía CTE: `cur` captura la activa (snapshot), `closed` le pone
// effective_to=now(), y el INSERT usa los valores viejos de `cur` con override.
// SET LOCAL bypass: el gate de four-eyes ya lo garantiza la app (status approved)
// + los constraints DB de approval_request; el trigger de plan_config se omite
// solo para esta publicación atómica.
func executePlanPublish(ctx context.Context, tx pgx.Tx, reqID, approverID int64) error {
	if _, err := tx.Exec(ctx, `SET LOCAL app.bypass_approval = 'on'`); err != nil {
		return err
	}
	cols := "version_label, effective_from, created_by_person_id, approval_request_id, notes"
	sel := "'v-'||to_char(now(),'YYYYMMDD\"T\"HH24MISS'), now(), $2, $1, 'four-eyes publish'"
	for _, f := range planEditableFields {
		cols += ", " + f.Key
		sel += fmt.Sprintf(", COALESCE((req.payload->>'%s')::%s, cur.%s)", f.Key, f.Cast, f.Key)
	}
	cols += ", settlement_available_lag"
	sel += ", cur.settlement_available_lag"

	sql := `
		WITH cur AS (
		  SELECT * FROM mlm.plan_config
		   WHERE effective_to IS NULL OR effective_to > now()
		   ORDER BY effective_from DESC LIMIT 1),
		     req AS (SELECT payload FROM mlm.approval_request WHERE id = $1),
		     closed AS (
		       UPDATE mlm.plan_config p SET effective_to = now()
		        WHERE p.id IN (SELECT id FROM cur) RETURNING p.id)
		INSERT INTO mlm.plan_config (` + cols + `)
		SELECT ` + sel + ` FROM cur, req`
	ct, err := tx.Exec(ctx, sql, reqID, approverID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("no hay config activa para publicar sobre")
	}
	return nil
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case int:
		return float64(n), true
	}
	return 0, false
}
