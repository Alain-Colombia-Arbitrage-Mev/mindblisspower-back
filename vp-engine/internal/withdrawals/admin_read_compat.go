package withdrawals

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Catalog introspection is explicit, read-only and independent of row contents.
// Never silently extract optional properties through to_jsonb(wr): a missing
// migration must remain observable, even when the current table is empty.
const withdrawalListColumnsSQL = `SELECT ARRAY(
	SELECT attname::text FROM pg_catalog.pg_attribute
	WHERE attrelid=to_regclass('mlm.withdrawal_request')
	AND attnum>0 AND NOT attisdropped
), EXISTS(SELECT 1 FROM pg_catalog.pg_class c
	JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
	WHERE n.nspname='payments' AND c.relname='stripe_sale' AND c.relkind='r')`

var withdrawalReadOptionalFields = [...]string{
	"fee_usd", "net_usd", "bmp_status", "bmp_email_used", "bmp_verified_at",
}

func withdrawalListReadProjection(columns []string, recovered bool) (string, []string, error) {
	present := make(map[string]bool, len(columns))
	for _, column := range columns {
		present[column] = true
	}
	// Absence of the relation or of core history columns is an error, not an
	// empty list. Only migration-49's five optional read fields are adaptable.
	for _, required := range []string{"id", "affiliate_id", "amount_usd", "status", "comments", "created_at"} {
		if !present[required] {
			return "", nil, fmt.Errorf("withdrawal read schema missing required column %s", required)
		}
	}
	parts := make([]string, 0, len(withdrawalReadOptionalFields))
	missing := []string{}
	for _, field := range withdrawalReadOptionalFields {
		if !present[field] {
			if !recovered {
				return "", nil, fmt.Errorf("withdrawal read schema missing column %s: migration required", field)
			}
			missing = append(missing, field)
			parts = append(parts, "''::text") // Scan sentinel; serialized as null below.
			continue
		}
		if field == "bmp_verified_at" {
			parts = append(parts, `COALESCE(to_char(wr.bmp_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'')`)
		} else {
			// The identifier comes solely from the fixed compile-time allowlist.
			parts = append(parts, "COALESCE(wr."+field+"::text,'')")
		}
	}
	return strings.Join(parts, ", "), missing, nil
}

func (w AdminWithdrawal) MarshalJSON() ([]byte, error) {
	type wire AdminWithdrawal
	encoded, err := json.Marshal(wire(w))
	if err != nil || len(w.MissingFields) == 0 {
		return encoded, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	for _, field := range withdrawalReadOptionalFields {
		for _, missing := range w.MissingFields {
			if field == missing {
				out[field] = json.RawMessage(`null`)
			}
		}
	}
	return json.Marshal(out)
}
