package payments

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// Envío de correos vía SES o SMTP. SES sigue como fallback histórico; si
// SMTP_HOST está configurado, SMTP gana para no depender del role AWS.
// Remitente configurable con EMAIL_FROM/SMTP_FROM; default no-reply del dominio.

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
	if v := strings.TrimSpace(firstEnv("SMTP_FROM", "EMAIL_FROM")); v != "" {
		return v
	}
	return "Mindbliss Power <no-reply@mindblisspower.com>"
}

// SendEmail envía un correo de texto plano a hasta maxEmailRecipients.
// Los destinatarios viajan en BCC/envelope para no exponer listas internas.
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

	if smtpConfigured() {
		if err := sendSMTPEmail(ctx, clean, subject, body); err != nil {
			return fmt.Errorf("smtp send: %w", err)
		}
		return nil
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

type smtpEmailConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	Helo     string
	TLSMode  string
}

func smtpConfigured() bool {
	return strings.TrimSpace(firstEnv("SMTP_HOST", "EMAIL_SMTP_HOST")) != ""
}

func loadSMTPEmailConfig() (smtpEmailConfig, error) {
	host := strings.TrimSpace(firstEnv("SMTP_HOST", "EMAIL_SMTP_HOST"))
	if host == "" {
		return smtpEmailConfig{}, fmt.Errorf("SMTP_HOST requerido")
	}
	port := 587
	if raw := strings.TrimSpace(firstEnv("SMTP_PORT", "EMAIL_SMTP_PORT")); raw != "" {
		p, err := strconv.Atoi(raw)
		if err != nil || p <= 0 || p > 65535 {
			return smtpEmailConfig{}, fmt.Errorf("SMTP_PORT inválido")
		}
		port = p
	}
	mode := strings.ToLower(strings.TrimSpace(firstEnv("SMTP_TLS_MODE", "EMAIL_SMTP_TLS_MODE")))
	if mode == "" {
		if port == 465 {
			mode = "tls"
		} else {
			mode = "starttls"
		}
	}
	if mode != "starttls" && mode != "tls" && mode != "none" {
		return smtpEmailConfig{}, fmt.Errorf("SMTP_TLS_MODE inválido")
	}
	return smtpEmailConfig{
		Host:     host,
		Port:     port,
		Username: strings.TrimSpace(firstEnv("SMTP_USERNAME", "SMTP_USER", "EMAIL_SMTP_USERNAME")),
		Password: firstEnv("SMTP_PASSWORD", "SMTP_PASS", "EMAIL_SMTP_PASSWORD"),
		From:     emailFrom(),
		Helo:     strings.TrimSpace(firstEnv("SMTP_HELO", "EMAIL_SMTP_HELO")),
		TLSMode:  mode,
	}, nil
}

func sendSMTPEmail(ctx context.Context, to []string, subject, body string) error {
	cfg, err := loadSMTPEmailConfig()
	if err != nil {
		return err
	}
	fromAddr, err := envelopeEmailAddress(cfg.From)
	if err != nil {
		return fmt.Errorf("from inválido: %w", err)
	}
	conn, err := dialSMTP(ctx, cfg)
	if err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer client.Close()

	if cfg.Helo != "" {
		if err := client.Hello(cfg.Helo); err != nil {
			return fmt.Errorf("hello: %w", err)
		}
	}
	if cfg.TLSMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("servidor SMTP no anuncia STARTTLS")
		}
		if err := client.StartTLS(smtpTLSConfig(cfg.Host)); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}
	if cfg.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)); err != nil {
			return fmt.Errorf("auth: %w", err)
		}
	}
	if err := client.Mail(fromAddr); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	for _, rcpt := range to {
		if err := client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("rcpt %s: %w", rcpt, err)
		}
	}
	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := wc.Write(buildPlainSMTPMessage(cfg.From, subject, body)); err != nil {
		_ = wc.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("close data: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("quit: %w", err)
	}
	return nil
}

func dialSMTP(ctx context.Context, cfg smtpEmailConfig) (net.Conn, error) {
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	}
	if cfg.TLSMode != "tls" {
		return conn, nil
	}
	tlsConn := tls.Client(conn, smtpTLSConfig(cfg.Host))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls handshake: %w", err)
	}
	return tlsConn, nil
}

func smtpTLSConfig(host string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: host,
	}
}

func envelopeEmailAddress(value string) (string, error) {
	addr, err := mail.ParseAddress(value)
	if err != nil {
		return "", err
	}
	return strings.ToLower(strings.TrimSpace(addr.Address)), nil
}

func buildPlainSMTPMessage(from, subject, body string) []byte {
	var b bytes.Buffer
	headers := []string{
		"From: " + smtpHeaderValue(from),
		"To: undisclosed-recipients:;",
		"Subject: " + mime.QEncoding.Encode("UTF-8", smtpHeaderValue(subject)),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"Date: " + time.Now().Format(time.RFC1123Z),
	}
	for _, h := range headers {
		b.WriteString(h)
		b.WriteString("\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(strings.ReplaceAll(normalizeEmailBody(body), "\n", "\r\n"))
	b.WriteString("\r\n")
	return b.Bytes()
}

func smtpHeaderValue(value string) string {
	return strings.Join(strings.Fields(strings.NewReplacer("\r", " ", "\n", " ").Replace(value)), " ")
}

func normalizeEmailBody(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return value
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
