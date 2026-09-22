package comms

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseSESEventDelivery(t *testing.T) {
	raw := []byte(`{"eventType":"Delivery","mail":{"messageId":"0100abc-1"},"delivery":{"processingTimeMillis":1400}}`)
	ev, err := ParseSESEvent(raw)
	if err != nil || ev.Type != "Delivery" || ev.MessageID != "0100abc-1" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
}

func TestParseSESEventBouncePermanent(t *testing.T) {
	raw := []byte(`{"eventType":"Bounce","mail":{"messageId":"m2"},"bounce":{"bounceType":"Permanent","bounceSubType":"General","bouncedRecipients":[{"diagnosticCode":"smtp; 550 5.1.1 user unknown"}]}}`)
	ev, err := ParseSESEvent(raw)
	if err != nil || !ev.Permanent || ev.Diagnostic != "smtp; 550 5.1.1 user unknown" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
	ev, _ = ParseSESEvent([]byte(`{"eventType":"Bounce","mail":{"messageId":"m3"},"bounce":{"bounceType":"Transient"}}`))
	if ev.Permanent {
		t.Fatal("transient bounce marked permanent")
	}
}

func TestParseSESEventComplaintAndGarbage(t *testing.T) {
	ev, err := ParseSESEvent([]byte(`{"eventType":"Complaint","mail":{"messageId":"m4"},"complaint":{"complaintFeedbackType":"abuse"}}`))
	if err != nil || ev.Type != "Complaint" || ev.Diagnostic != "abuse" {
		t.Fatalf("ev = %+v, err = %v", ev, err)
	}
	if _, err := ParseSESEvent([]byte(`not json`)); err == nil {
		t.Fatal("expected error")
	}
	if _, err := ParseSESEvent([]byte(`{"eventType":"Send"}`)); err == nil {
		t.Fatal("expected error: missing messageId")
	}
}

// TestParseSESEventNotificationType: SNS entrega las notificaciones "legacy" de SES
// con la clave `notificationType` en lugar de `eventType` (I3a). Ambas deben parsear.
func TestParseSESEventNotificationType(t *testing.T) {
	ev, err := ParseSESEvent([]byte(`{"notificationType":"Bounce","mail":{"messageId":"m9"},"bounce":{"bounceType":"Permanent"}}`))
	if err != nil {
		t.Fatalf("ParseSESEvent: %v", err)
	}
	if ev.Type != "Bounce" || ev.MessageID != "m9" || !ev.Permanent {
		t.Fatalf("ev = %+v", ev)
	}
}

// TestTruncateIsRuneSafe: truncar por bytes parte un carácter multibyte por la mitad
// y produce UTF-8 inválido, que Postgres rechaza al guardar en last_error (I10).
func TestTruncateIsRuneSafe(t *testing.T) {
	s := strings.Repeat("é", 400)
	got := truncate(s, 300)
	if n := utf8.RuneCountInString(got); n != 300 {
		t.Fatalf("runes = %d, want 300", n)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("truncate produced invalid UTF-8: %q", got)
	}
	if truncate("abc", 10) != "abc" {
		t.Fatal("truncate must not touch short strings")
	}
}
