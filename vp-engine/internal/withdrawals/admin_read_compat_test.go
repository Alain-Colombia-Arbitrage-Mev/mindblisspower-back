package withdrawals

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWithdrawalReadCompatibilityMissingColumnsIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "historical@test.local", "1000")
	store := NewStore(pool)
	request, err := store.RequestWithdrawal(ctx, "historical@test.local", "200", "Historical destination")
	if err != nil {
		t.Fatal(err)
	}
	// Entirely synthetic historical recovery shape. No backfill and no
	// production DDL: this fixture belongs to the isolated testcontainer.
	if _, err := pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS payments;
		CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY);
		ALTER TABLE mlm.withdrawal_request DROP COLUMN fee_usd, DROP COLUMN net_usd,
			DROP COLUMN bmp_status, DROP COLUMN bmp_email_used, DROP COLUMN bmp_verified_at;
		CREATE ROLE fixture_withdrawal_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
		GRANT USAGE ON SCHEMA mlm TO fixture_withdrawal_reader;
		GRANT SELECT ON mlm.withdrawal_request,mlm.person,mlm.affiliate TO fixture_withdrawal_reader;`); err != nil {
		t.Fatal(err)
	}
	readerConfig := pool.Config().Copy()
	readerConfig.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE fixture_withdrawal_reader; SET default_transaction_read_only=on")
		return err
	}
	reader, err := pgxpool.NewWithConfig(ctx, readerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	// No USAGE on payments and no financial writes. This reproduces the
	// withdrawal service's deliberately smaller catalog/data access scope.
	store = NewStore(reader)
	rows, total, err := store.ListWithdrawals(ctx, "", 25, 0)
	if err != nil || total != 1 || len(rows) != 1 {
		t.Fatalf("historical read: total=%d rows=%d error=%v", total, len(rows), err)
	}
	if rows[0].ID != request.ID || rows[0].AmountUSD != "200.00" || rows[0].Status != "requested" || len(rows[0].MissingFields) != 5 {
		t.Fatalf("history was altered or missing schema hidden: %+v", rows[0])
	}
	encoded, err := json.Marshal(rows[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range withdrawalReadOptionalFields {
		if !strings.Contains(string(encoded), `"`+field+`":null`) {
			t.Fatalf("unknown field %s was invented: %s", field, encoded)
		}
	}
}

func TestWithdrawalReadCompatibilityExplicitUnknownFields(t *testing.T) {
	// Withdrawal readers deliberately have no USAGE/SELECT on payments.
	// Catalog-only detection must not broaden that policy or resolve a
	// qualified payments relation with to_regclass (which requires USAGE).
	if strings.Contains(withdrawalListColumnsSQL, "to_regclass('payments.") || !strings.Contains(withdrawalListColumnsSQL, "pg_catalog.pg_namespace") {
		t.Fatal("recovery detection must respect the withdrawal reader ACL")
	}
	core := []string{"id", "affiliate_id", "amount_usd", "status", "comments", "created_at"}
	projection, missing, err := withdrawalListReadProjection(core, true)
	if err != nil || len(missing) != 5 || strings.Count(projection, "''::text") != 5 {
		t.Fatalf("historical projection = %q, %v, %v", projection, missing, err)
	}
	w := AdminWithdrawal{AmountUSD: "200.00", Status: "requested", ReadModelStatus: "historical_schema_incomplete", MissingFields: missing}
	b, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, field := range withdrawalReadOptionalFields {
		if value, ok := decoded[field]; !ok || value != nil {
			t.Fatalf("unknown %s must be explicit null, got %v", field, value)
		}
	}
	if decoded["amount_usd"] != "200.00" || decoded["status"] != "requested" || decoded["read_model_status"] != "historical_schema_incomplete" {
		t.Fatal("historical facts or schema warning lost")
	}
}

func TestWithdrawalReadCompatibilityNeverHidesBrokenOperationalSchema(t *testing.T) {
	core := []string{"id", "affiliate_id", "amount_usd", "status", "comments", "created_at"}
	if _, _, err := withdrawalListReadProjection(core, false); err == nil {
		t.Fatal("operational database without migration49 must fail")
	}
	if _, _, err := withdrawalListReadProjection([]string{"fee_usd"}, true); err == nil {
		t.Fatal("missing core history columns must fail even on recovery database")
	}
}

func TestWithdrawalReadCompatibilityPreservesCompleteSchema(t *testing.T) {
	columns := append([]string{"id", "affiliate_id", "amount_usd", "status", "comments", "created_at"}, withdrawalReadOptionalFields[:]...)
	projection, missing, err := withdrawalListReadProjection(columns, false)
	if err != nil || len(missing) != 0 || !strings.Contains(projection, "wr.fee_usd::text") || !strings.Contains(projection, "AT TIME ZONE 'UTC'") {
		t.Fatal(projection, missing, err)
	}
	b, err := json.Marshal(AdminWithdrawal{FeeUSD: "8.00", NetUSD: "192.00", BMPStatus: "allowed"})
	if err != nil || !strings.Contains(string(b), `"fee_usd":"8.00"`) || strings.Contains(string(b), "missing_fields") {
		t.Fatalf("normal wire contract changed: %s, %v", b, err)
	}
}
