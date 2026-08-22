package payments

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"
)

func TestNormalizeUsersExportStatusFilter(t *testing.T) {
	tests := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{"", "", true},
		{"all", "", true},
		{"todos", "", true},
		{"activo", "active", true},
		{"active", "active", true},
		{"inactivo", "inactive", true},
		{"inactive", "inactive", true},
		{"suspended", "", false},
	}
	for _, tt := range tests {
		got, ok := normalizeUsersExportStatusFilter(tt.in)
		if got != tt.want || ok != tt.wantOK {
			t.Fatalf("normalizeUsersExportStatusFilter(%q) = %q,%v; want %q,%v", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}

func TestAdminUsersCSVSanitizesFormulaCells(t *testing.T) {
	id := int64(10)
	body, err := adminUsersCSV([]AdminUserExportRow{{
		PersonID:        1,
		Name:            "=cmd",
		FirstName:       "Ana",
		LastName:        "Power",
		Email:           "ana@example.com",
		Phone:           "+573001112233",
		Status:          "active",
		Active:          true,
		KYCStatus:       "approved",
		AffiliateID:     &id,
		AffiliateCode:   "MP10",
		NetworkPosition: "L",
		LeftCount:       3,
		RightCount:      2,
		OwnPurchasesUSD: "101.00",
		TotalSalesUSD:   "202.00",
	}})
	if err != nil {
		t.Fatalf("adminUsersCSV: %v", err)
	}
	body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})
	records, err := csv.NewReader(bytes.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("records len = %d, want 2", len(records))
	}
	header := records[0]
	row := records[1]
	idx := func(name string) int {
		for i, h := range header {
			if h == name {
				return i
			}
		}
		t.Fatalf("missing header %q in %v", name, header)
		return -1
	}
	if got := row[idx("nombre")]; got != "'=cmd" {
		t.Fatalf("nombre = %q, want sanitized formula", got)
	}
	if got := row[idx("telefono")]; got != "'+573001112233" {
		t.Fatalf("telefono = %q, want sanitized plus-prefixed phone", got)
	}
	if got := row[idx("monto_total_ventas_usd")]; !strings.EqualFold(got, "202.00") {
		t.Fatalf("monto_total_ventas_usd = %q", got)
	}
}
