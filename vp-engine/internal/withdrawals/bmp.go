package withdrawals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Motivos de bloqueo (BlockReason). Cadena vacía ⇒ elegible.
const (
	BlockNotRegistered = "not_registered" // no tiene cuenta BMP
	BlockKYCPending    = "kyc_pending"    // Bridge no activo
	BlockVAIncomplete  = "va_incomplete"  // sin cuenta virtual: no hay dónde depositar
	BlockBMPBlocked    = "bmp_blocked"    // BMP bloquea por un motivo propio
	BlockUnavailable   = "unavailable"    // BMP no responde
)

// verificationPath es el ÚNICO endpoint que consumimos. user-eligibility se
// descarta: no devuelve restrictionReason ni bridgeCustomerStatus, y exige
// tarjeta activa (ver D8/D9 en el spec).
const verificationPath = "/api/v1/mindpower/user-verification"

// maxBMPResponseBody acota el body de la respuesta de BMP (paridad con
// internal/withdrawals/http.go: json.NewDecoder(io.LimitReader(r.Body, 1<<16))).
// BMP es un tercero: no confiamos en que su respuesta venga acotada.
const maxBMPResponseBody = int64(1 << 16) // 64 KiB

// ErrBMPAuth indica que BMP rechazó NUESTRAS credenciales (401/403). No es un
// bloqueo del afiliado consultado: bloquea la verificación de TODOS los
// afiliados, así que el caller debe usar errors.Is(err, ErrBMPAuth) para
// emitir una alerta operativa diferenciada (Task 9).
var ErrBMPAuth = errors.New("bmp: credenciales rechazadas")

// BMPVerification es la respuesta de BMP ya traducida a decisión de negocio. El
// frontend nunca interpreta campos crudos de BMP: esta traducción es el único
// lugar donde vive la regla.
type BMPVerification struct {
	Exists      bool      `json:"exists"`
	CanWithdraw bool      `json:"can_withdraw"`
	BlockReason string    `json:"block_reason"`
	UserID      string    `json:"user_id"`
	CheckedAt   time.Time `json:"checked_at"`

	// Señales granulares: se persisten y se muestran al admin, pero solo
	// VirtualAccountActivated y BridgeCustomerStatus participan del candado.
	VirtualAccountActivated bool   `json:"virtual_account_activated"`
	CardActivated           bool   `json:"card_activated"`
	BridgeCustomerStatus    string `json:"bridge_customer_status"`
	WithdrawalStatus        string `json:"withdrawal_status"`
	RestrictionReason       string `json:"restriction_reason"`
}

// bmpRawResponse mapea la respuesta cruda documentada en developer_apis.pdf.
type bmpRawResponse struct {
	Exists bool `json:"exists"`
	User   struct {
		UserID   string `json:"userId"`
		Email    string `json:"email"`
		Username string `json:"username"`
	} `json:"user"`
	VirtualAccountActivated bool   `json:"virtualAccountActivated"`
	CardActivated           bool   `json:"cardActivated"`
	IsFullyActivated        bool   `json:"isFullyActivated"`
	WithdrawalStatus        string `json:"withdrawalStatus"`
	RestrictionReason       string `json:"restrictionReason"`
	BridgeCustomerID        string `json:"bridgeCustomerId"`
	BridgeCustomerStatus    string `json:"bridgeCustomerStatus"`
}

type BMPClient struct {
	baseURL      string
	clientID     string
	clientSecret string
	httpClient   *http.Client
}

// NewBMPClient construye el cliente. Timeout 10s: está en un camino interactivo,
// no en un batch (networkintel usa 35s, kycocr 55s). Sin reintentos automáticos.
func NewBMPClient(baseURL, clientID, clientSecret string) *BMPClient {
	return &BMPClient{
		baseURL:      strings.TrimRight(baseURL, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Enabled indica si hay credenciales configuradas.
func (c *BMPClient) Enabled() bool {
	return c != nil && c.clientID != "" && c.clientSecret != ""
}

// VerifyUser consulta BMP y devuelve la decisión traducida. Ante cualquier fallo
// devuelve error Y una verificación con BlockReason=BlockUnavailable, para que
// el caller pueda persistir el estado sin ramificar.
func (c *BMPClient) VerifyUser(ctx context.Context, email string) (BMPVerification, error) {
	unavailable := BMPVerification{BlockReason: BlockUnavailable, CheckedAt: time.Now().UTC()}

	if !c.Enabled() {
		return unavailable, fmt.Errorf("bmp: credenciales no configuradas")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return unavailable, fmt.Errorf("bmp: email vacío")
	}

	endpoint := c.baseURL + verificationPath + "?email=" + url.QueryEscape(email)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return unavailable, fmt.Errorf("bmp: build request: %w", err)
	}
	// Nombres de header EXACTOS que exige BMP: prefijo x- obligatorio. Sin él la
	// API responde 401 "Missing client credentials" (verificado contra prod). El
	// nombre HTTP es case-insensitive, pero "Client-Id" (sin x-) NO lo reconoce.
	req.Header.Set("x-client-id", c.clientID)
	req.Header.Set("x-client-secret", c.clientSecret)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return unavailable, fmt.Errorf("bmp: request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// 401/403 significan que NUESTRAS credenciales fallaron, no las del
		// afiliado: el caller debe alertar, porque bloquea TODOS los pagos.
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return unavailable, fmt.Errorf("bmp: status %d: %w", resp.StatusCode, ErrBMPAuth)
		}
		return unavailable, fmt.Errorf("bmp: status %d", resp.StatusCode)
	}

	var raw bmpRawResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBMPResponseBody)).Decode(&raw); err != nil {
		return unavailable, fmt.Errorf("bmp: decode: %w", err)
	}

	return translate(raw), nil
}

// translate aplica la regla D9. El orden de evaluación importa: se reporta el
// bloqueo MÁS TEMPRANO de la cadena, que es el que el usuario debe resolver
// primero.
//
//	CanWithdraw = virtualAccountActivated && bridgeCustomerStatus=="active"
//	              && withdrawalStatus=="allowed"
//
// cardActivated e isFullyActivated se guardan pero NO bloquean: la tarjeta
// PayCrypto sirve para gastar, no para recibir.
func translate(raw bmpRawResponse) BMPVerification {
	v := BMPVerification{
		Exists:                  raw.Exists,
		UserID:                  raw.User.UserID,
		CheckedAt:               time.Now().UTC(),
		VirtualAccountActivated: raw.VirtualAccountActivated,
		CardActivated:           raw.CardActivated,
		BridgeCustomerStatus:    raw.BridgeCustomerStatus,
		WithdrawalStatus:        raw.WithdrawalStatus,
		RestrictionReason:       raw.RestrictionReason,
	}

	switch {
	case !raw.Exists:
		v.BlockReason = BlockNotRegistered
	case !strings.EqualFold(raw.BridgeCustomerStatus, "active"):
		v.BlockReason = BlockKYCPending
	case !raw.VirtualAccountActivated:
		v.BlockReason = BlockVAIncomplete
	case !strings.EqualFold(raw.WithdrawalStatus, "allowed"):
		v.BlockReason = BlockBMPBlocked
	default:
		v.CanWithdraw = true
	}
	return v
}
