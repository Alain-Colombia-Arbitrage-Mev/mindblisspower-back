package payments

import (
	"context"
	"testing"
	"time"
)

func TestSecurityPendingChargeSummary_IncludesManualOperationalCharges(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()

	ctx := context.Background()
	store := NewStore(pool)
	occurredAt := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)

	failed, err := store.RecordOperationalCharge(ctx, "rejected", 5, "processor report: rejected card attempts", "admin@test.local", occurredAt)
	if err != nil {
		t.Fatalf("record rejected charges: %v", err)
	}
	if failed.ChargeType != "failed" || failed.Quantity != 5 || failed.TotalAmountUSD != "350.00" {
		t.Fatalf("failed adjustment = %#v, want failed/5/350.00", failed)
	}
	refunded, err := store.RecordOperationalCharge(ctx, "reembolso", 1, "processor report: refund process", "admin@test.local", occurredAt)
	if err != nil {
		t.Fatalf("record refund charge: %v", err)
	}
	if refunded.ChargeType != "refunded" || refunded.Quantity != 1 || refunded.TotalAmountUSD != "70.00" {
		t.Fatalf("refunded adjustment = %#v, want refunded/1/70.00", refunded)
	}

	sum, err := store.SecurityPendingChargeSummary(ctx, time.Time{})
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if sum.AffectedSales != 6 || sum.PendingChargeUSD != "420.00" {
		t.Fatalf("summary affected/pending = %d/%s, want 6/420.00", sum.AffectedSales, sum.PendingChargeUSD)
	}
	if sum.FailedSales != 5 || sum.RefundedSales != 1 || sum.ManualAdjustments != 6 || sum.ManualChargeUSD != "420.00" {
		t.Fatalf("summary breakdown = failed %d refunded %d manual %d manualUSD %s, want 5/1/6/420.00",
			sum.FailedSales, sum.RefundedSales, sum.ManualAdjustments, sum.ManualChargeUSD)
	}

	var auditRows int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM audit.activity_log
		 WHERE entity_type = 'payments.operational_charge_adjustment'
		   AND action = 'created'
	`).Scan(&auditRows); err != nil {
		t.Fatalf("audit count: %v", err)
	}
	if auditRows != 2 {
		t.Fatalf("audit rows = %d, want 2", auditRows)
	}
}

func TestSecurityPendingChargeSummary_UsesAuditFallbackWithoutAdjustmentTable(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()

	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DROP TABLE payments.operational_charge_adjustment`); err != nil {
		t.Fatalf("drop adjustment table: %v", err)
	}

	store := NewStore(pool)
	_, err := store.RecordOperationalCharge(
		ctx,
		"rejected",
		6,
		"processor report without DDL table",
		"admin@test.local",
		time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("record fallback charge: %v", err)
	}

	sum, err := store.SecurityPendingChargeSummary(ctx, time.Time{})
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if sum.AffectedSales != 6 || sum.PendingChargeUSD != "420.00" || sum.FailedSales != 6 || sum.ManualAdjustments != 6 {
		t.Fatalf("summary = affected %d pending %s failed %d manual %d, want 6/420.00/6/6",
			sum.AffectedSales, sum.PendingChargeUSD, sum.FailedSales, sum.ManualAdjustments)
	}
}

func TestSecurityPendingChargeSummary_UsesEventFallback(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()

	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.stripe_event (event_id, type)
		VALUES
			('opcharge:test:failed:5', 'manual_operational_charge:failed:5:350.00:70.00'),
			('opcharge:test:refunded:1', 'manual_operational_charge:refunded:1:70.00:70.00'),
			('opcharge:test:invalid', 'manual_operational_charge:failed:bad:bad:70.00')
	`); err != nil {
		t.Fatalf("insert fallback events: %v", err)
	}

	store := NewStore(pool)
	sum, err := store.SecurityPendingChargeSummary(ctx, time.Time{})
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if sum.AffectedSales != 6 || sum.PendingChargeUSD != "420.00" {
		t.Fatalf("summary affected/pending = %d/%s, want 6/420.00", sum.AffectedSales, sum.PendingChargeUSD)
	}
	if sum.FailedSales != 5 || sum.RefundedSales != 1 || sum.ManualAdjustments != 6 || sum.ManualChargeUSD != "420.00" {
		t.Fatalf("summary breakdown = failed %d refunded %d manual %d manualUSD %s, want 5/1/6/420.00",
			sum.FailedSales, sum.RefundedSales, sum.ManualAdjustments, sum.ManualChargeUSD)
	}
}
