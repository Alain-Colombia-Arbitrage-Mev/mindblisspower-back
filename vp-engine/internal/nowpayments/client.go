// Package nowpayments provides the hosted invoice and payment evidence API.
// It never credits a wallet, activates a pack, or initiates a payout.
package nowpayments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	productionAPI  = "https://api.nowpayments.io/v1"
	sandboxAPI     = "https://api-sandbox.nowpayments.io/v1"
	maxBody        = 128 << 10
	requestTimeout = 15 * time.Second
)

var (
	ErrConfiguration = errors.New("nowpayments: invalid configuration")
	ErrInvalidInput  = errors.New("nowpayments: invalid input")
	ErrProvider      = errors.New("nowpayments: provider request failed")
	ErrResponse      = errors.New("nowpayments: invalid provider response")
	ErrSignature     = errors.New("nowpayments: invalid IPN signature")
	ErrEvidence      = errors.New("nowpayments: payment evidence mismatch")
	ErrNotFinished   = errors.New("nowpayments: payment is not finished")
	idPattern        = regexp.MustCompile(`^[1-9][0-9]{0,63}$`)
	orderPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

// Config is server-only. HTTPClient may supply an injected transport for tests.
// API endpoints cannot be overridden with caller-controlled URLs.
type Config struct {
	APIKey      string       `json:"-"`
	IPNSecret   string       `json:"-"`
	Environment string       `json:"environment,omitempty"` // production (default) or sandbox; never inferred from keys
	HTTPClient  *http.Client `json:"-"`
}

func (Config) String() string   { return "nowpayments.Config{credentials:redacted}" }
func (Config) GoString() string { return "nowpayments.Config{credentials:redacted}" }

type Status struct {
	APIKeyConfigured    bool
	IPNSecretConfigured bool
}

// ConfigurationStatus is safe to use for server-side readiness diagnostics. It
// deliberately returns no secret fragments, provider responses, or account data.
func ConfigurationStatus(cfg Config) Status {
	return Status{APIKeyConfigured: strings.TrimSpace(cfg.APIKey) != "", IPNSecretConfigured: strings.TrimSpace(cfg.IPNSecret) != ""}
}

type Client struct {
	apiKey, ipnSecret, baseURL, invoiceHost string
	httpClient                              *http.Client
}

func (*Client) String() string   { return "nowpayments.Client{credentials:redacted}" }
func (*Client) GoString() string { return "nowpayments.Client{credentials:redacted}" }

func New(cfg Config) (*Client, error) {
	key, secret := strings.TrimSpace(cfg.APIKey), strings.TrimSpace(cfg.IPNSecret)
	if key == "" || len(key) > 4096 || strings.ContainsAny(key, "\r\n") || len(secret) > 4096 {
		return nil, ErrConfiguration
	}
	base, invoiceHost := productionAPI, "nowpayments.io"
	switch cfg.Environment {
	case "", "production":
	case "sandbox":
		base, invoiceHost = sandboxAPI, "sandbox.nowpayments.io"
	default:
		return nil, ErrConfiguration
	}
	hc := http.Client{}
	if cfg.HTTPClient != nil {
		hc = *cfg.HTTPClient
	}
	hc.Timeout = requestTimeout
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{apiKey: key, ipnSecret: secret, baseURL: base, invoiceHost: invoiceHost, httpClient: &hc}, nil
}

type InvoiceRequest struct {
	OrderID        string
	AmountUSDMinor int64
	Description    string
	CallbackURL    string
	SuccessURL     string
	CancelURL      string
}

type Invoice struct {
	ID  string
	URL string
}

func validHTTPS(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(raw) > 2048 || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate()) {
		return false
	}
	return true
}

// CreateInvoice refuses new invoices without an IPN secret. A redirect to the
// success page is not payment evidence; only a verified finished payment is.
func (c *Client) CreateInvoice(ctx context.Context, in InvoiceRequest) (Invoice, error) {
	if c == nil || c.ipnSecret == "" {
		return Invoice{}, ErrConfiguration
	}
	if !orderPattern.MatchString(in.OrderID) || in.AmountUSDMinor <= 0 || len(in.Description) > 256 ||
		!validHTTPS(in.CallbackURL) || !validHTTPS(in.SuccessURL) || !validHTTPS(in.CancelURL) {
		return Invoice{}, ErrInvalidInput
	}
	request := struct {
		Amount      json.Number `json:"price_amount"`
		Currency    string      `json:"price_currency"`
		OrderID     string      `json:"order_id"`
		Description string      `json:"order_description,omitempty"`
		Callback    string      `json:"ipn_callback_url"`
		Success     string      `json:"success_url"`
		Cancel      string      `json:"cancel_url"`
	}{json.Number(fmt.Sprintf("%d.%02d", in.AmountUSDMinor/100, in.AmountUSDMinor%100)), "usd", in.OrderID, in.Description, in.CallbackURL, in.SuccessURL, in.CancelURL}
	body, err := json.Marshal(request)
	if err != nil {
		return Invoice{}, ErrInvalidInput
	}
	response, err := c.do(ctx, http.MethodPost, "/invoice", body)
	if err != nil {
		return Invoice{}, err
	}
	var result struct {
		ID  ProviderID `json:"id"`
		URL string     `json:"invoice_url"`
	}
	if err := json.Unmarshal(response, &result); err != nil || !idPattern.MatchString(string(result.ID)) {
		return Invoice{}, ErrResponse
	}
	u, err := url.Parse(result.URL)
	if err != nil || !validHTTPS(result.URL) || u.Host != c.invoiceHost ||
		(u.Path != "/payment" && u.Path != "/payment/") {
		return Invoice{}, ErrResponse
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query["iid"]) != 1 || query.Get("iid") != string(result.ID) {
		return Invoice{}, ErrResponse
	}
	for key, values := range query {
		if len(values) != 1 || (key != "iid" && key != "source") || (key == "source" && !orderPattern.MatchString(values[0])) {
			return Invoice{}, ErrResponse
		}
	}
	return Invoice{ID: string(result.ID), URL: result.URL}, nil
}

// ProviderID accepts either a JSON string or integer without float conversion.
type ProviderID string

func (id *ProviderID) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		*id = ""
		return nil
	}
	value := string(raw)
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &value); err != nil {
			return ErrResponse
		}
	}
	if !idPattern.MatchString(value) {
		return ErrResponse
	}
	*id = ProviderID(value)
	return nil
}

// Decimal preserves a provider's JSON decimal exactly, including numeric strings.
type Decimal string

func (d *Decimal) UnmarshalJSON(raw []byte) error {
	value := string(raw)
	if value == "null" {
		*d = ""
		return nil
	}
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &value); err != nil {
			return ErrResponse
		}
	}
	if _, err := canonicalNumber(value); err != nil {
		return ErrResponse
	}
	*d = Decimal(value)
	return nil
}

type Payment struct {
	PaymentID     ProviderID `json:"payment_id"`
	InvoiceID     ProviderID `json:"invoice_id"`
	OrderID       string     `json:"order_id"`
	Status        string     `json:"payment_status"`
	PriceAmount   Decimal    `json:"price_amount"`
	PriceCurrency string     `json:"price_currency"`
	PayAmount     Decimal    `json:"pay_amount"`
	ActuallyPaid  Decimal    `json:"actually_paid"`
	PayCurrency   string     `json:"pay_currency"`
	// Outcome is provider-reported settlement evidence, not USD gross or an
	// automatically spendable balance. Its currency may be cryptocurrency.
	OutcomeAmount   Decimal `json:"outcome_amount,omitempty"`
	OutcomeCurrency string  `json:"outcome_currency,omitempty"`
}

func decodePayment(body []byte) (Payment, error) {
	var p Payment
	if _, err := canonicalJSON(body); err != nil {
		return p, ErrResponse
	}
	if err := json.Unmarshal(body, &p); err != nil || !idPattern.MatchString(string(p.PaymentID)) || p.Status == "" {
		return Payment{}, ErrResponse
	}
	return p, nil
}

func (c *Client) GetPayment(ctx context.Context, paymentID string) (Payment, error) {
	if c == nil || !idPattern.MatchString(paymentID) {
		return Payment{}, ErrInvalidInput
	}
	body, err := c.do(ctx, http.MethodGet, "/payment/"+paymentID, nil)
	if err != nil {
		return Payment{}, err
	}
	p, err := decodePayment(body)
	if err != nil || string(p.PaymentID) != paymentID {
		return Payment{}, ErrResponse
	}
	return p, nil
}

func (c *Client) do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, ErrInvalidInput
	}
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(req)
	if err != nil {
		// Do not wrap transport errors: injected/proxy errors can contain secrets.
		return nil, ErrProvider
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, ErrProvider
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil || len(data) > maxBody {
		return nil, ErrResponse
	}
	if _, err := canonicalJSON(data); err != nil {
		return nil, ErrResponse
	}
	return data, nil
}

// ExpectedPayment must come from a persisted, server-created order. All three
// provider identifiers are mandatory, not values to trust from the webhook.
type ExpectedPayment struct {
	OrderID        string
	InvoiceID      string
	PaymentID      string
	AmountUSDMinor int64
}

// ValidateFinished checks evidence only. The caller must still perform an atomic
// state transition with a unique provider payment ID to prevent replay credits.
func ValidateFinished(p Payment, want ExpectedPayment) error {
	if !orderPattern.MatchString(want.OrderID) || !idPattern.MatchString(want.InvoiceID) ||
		!idPattern.MatchString(want.PaymentID) || want.AmountUSDMinor <= 0 || p.OrderID != want.OrderID ||
		string(p.InvoiceID) != want.InvoiceID || string(p.PaymentID) != want.PaymentID || p.PriceCurrency != "usd" {
		return ErrEvidence
	}
	price, ok := exactRat(p.PriceAmount)
	if !ok || price.Cmp(new(big.Rat).SetFrac(big.NewInt(want.AmountUSDMinor), big.NewInt(100))) != 0 {
		return ErrEvidence
	}
	if p.Status != "finished" {
		return ErrNotFinished
	}
	pay, payOK := exactRat(p.PayAmount)
	actual, actualOK := exactRat(p.ActuallyPaid)
	if !payOK || !actualOK || pay.Sign() <= 0 || actual.Cmp(pay) < 0 || p.PayCurrency == "" {
		return ErrEvidence
	}
	return nil
}

func exactRat(value Decimal) (*big.Rat, bool) {
	canonical, err := canonicalNumber(string(value))
	if err != nil {
		return nil, false
	}
	r, ok := new(big.Rat).SetString(canonical)
	return r, ok
}

// FormatUSDMinor is shared with callers that persist or display exact cents.
func FormatUSDMinor(value int64) (string, error) {
	if value <= 0 {
		return "", ErrInvalidInput
	}
	return strconv.FormatInt(value/100, 10) + fmt.Sprintf(".%02d", value%100), nil
}
