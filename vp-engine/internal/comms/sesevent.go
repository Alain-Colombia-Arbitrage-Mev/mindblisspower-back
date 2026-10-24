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
	// NotificationType: las notificaciones "legacy" de SES (publicadas por el
	// propio identity notification topic, no por un event destination del
	// configuration set) traen el tipo bajo esta clave. Aceptar ambas evita
	// perder rebotes/quejas en silencio.
	NotificationType string `json:"notificationType"`
	Mail             struct {
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
	evType := r.EventType
	if evType == "" {
		evType = r.NotificationType
	}
	if r.Mail.MessageID == "" || evType == "" {
		return SESEvent{}, errors.New("ses event: falta eventType/notificationType o messageId")
	}
	ev := SESEvent{Type: evType, MessageID: r.Mail.MessageID}
	switch evType {
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

// truncate corta a n RUNAS, no a n bytes: cortar por bytes puede partir un
// carácter multibyte y dejar UTF-8 inválido, que Postgres rechaza al guardarlo
// (los diagnósticos de SES vienen con acentos y comillas tipográficas).
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
