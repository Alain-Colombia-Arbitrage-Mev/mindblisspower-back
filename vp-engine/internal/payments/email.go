package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// Envío de correos vía SES (dominio mindblisspower.com verificado, DKIM OK).
// Remitente configurable con EMAIL_FROM; default no-reply del dominio.
// El instance role necesita ses:SendEmail (policy propia del feature).

const maxEmailRecipients = 50

var (
	sesOnce   sync.Once
	sesClient *sesv2.Client
	sesErr    error
)

func getSES(ctx context.Context) (*sesv2.Client, error) {
	sesOnce.Do(func() {
		cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
		if err != nil {
			sesErr = fmt.Errorf("aws config: %w", err)
			return
		}
		sesClient = sesv2.NewFromConfig(cfg)
	})
	return sesClient, sesErr
}

func emailFrom() string {
	if v := strings.TrimSpace(os.Getenv("EMAIL_FROM")); v != "" {
		return v
	}
	return "Mindbliss Power <no-reply@mindblisspower.com>"
}

// SendEmail envía un correo de texto plano a hasta maxEmailRecipients
// destinatarios (BCC para no exponer la lista entre miembros).
func (s *Store) SendEmail(ctx context.Context, to []string, subject, body string) error {
	clean := make([]string, 0, len(to))
	for _, t := range to {
		if t = strings.ToLower(strings.TrimSpace(t)); t != "" && strings.Contains(t, "@") {
			clean = append(clean, t)
		}
	}
	if len(clean) == 0 {
		return fmt.Errorf("sin destinatarios válidos")
	}
	if len(clean) > maxEmailRecipients {
		return fmt.Errorf("máximo %d destinatarios por envío", maxEmailRecipients)
	}

	client, err := getSES(ctx)
	if err != nil {
		return err
	}
	from := emailFrom()
	_, err = client.SendEmail(ctx, &sesv2.SendEmailInput{
		FromEmailAddress: &from,
		Destination: &sestypes.Destination{
			BccAddresses: clean,
		},
		Content: &sestypes.EmailContent{
			Simple: &sestypes.Message{
				Subject: &sestypes.Content{Data: aws.String(subject), Charset: aws.String("UTF-8")},
				Body: &sestypes.Body{
					Text: &sestypes.Content{Data: aws.String(body), Charset: aws.String("UTF-8")},
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("ses send: %w", err)
	}
	return nil
}

// handleAdminEmail: POST /api/admin/email {to: [emails], subject, body}
// Envío manual desde el panel admin. Auditable vía evento admin.email_sent.
func (h *Handler) handleAdminEmail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		To      []string `json:"to"`
		Subject string   `json:"subject"`
		Body    string   `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		len(req.To) == 0 || strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "to_subject_body_required")
		return
	}
	if err := h.store.SendEmail(r.Context(), req.To, req.Subject, req.Body); err != nil {
		h.log.Error().Err(err).Msg("admin email send")
		writeErr(w, http.StatusBadGateway, "email_send_failed")
		return
	}
	h.store.cache.PublishEvent(r.Context(), "admin.email_sent", map[string]any{
		"by": adminEmail, "recipients": len(req.To), "subject": req.Subject,
	})
	h.log.Info().Str("by", adminEmail).Int("recipients", len(req.To)).Msg("admin email sent")
	writeJSON(w, http.StatusOK, map[string]any{"sent": len(req.To)})
}
