package comms

import "testing"

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
