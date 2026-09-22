package comms

import (
	"encoding/json"
	"errors"
)

type SESEvent struct {
	Type       string
	MessageID  string
	Permanent  bool
	Diagnostic string
}

type rawSESEvent struct {
	EventType string `json:"eventType"`
	Mail      struct {
		MessageID string `json:"messageId"`
	} `json:"mail"`
	Bounce struct {
		BounceType        string `json:"bounceType"`
		BouncedRecipients []struct {
			DiagnosticCode string `json:"diagnosticCode"`
		} `json:"bouncedRecipients"`
	} `json:"bounce"`
	Complaint struct {
		ComplaintFeedbackType string `json:"complaintFeedbackType"`
	} `json:"complaint"`
}

func ParseSESEvent(raw []byte) (SESEvent, error) {
	var r rawSESEvent
	if err := json.Unmarshal(raw, &r); err != nil {
		return SESEvent{}, err
	}
	if r.Mail.MessageID == "" || r.EventType == "" {
		return SESEvent{}, errors.New("ses event: falta eventType o messageId")
	}
	ev := SESEvent{Type: r.EventType, MessageID: r.Mail.MessageID}
	switch r.EventType {
	case "Bounce":
		ev.Permanent = r.Bounce.BounceType == "Permanent"
		if len(r.Bounce.BouncedRecipients) > 0 {
			ev.Diagnostic = truncate(r.Bounce.BouncedRecipients[0].DiagnosticCode, 300)
		}
	case "Complaint":
		ev.Diagnostic = truncate(r.Complaint.ComplaintFeedbackType, 300)
	}
	return ev, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
