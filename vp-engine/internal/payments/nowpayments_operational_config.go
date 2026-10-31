package payments

import (
	"errors"
	"net/url"
	"os"
	"strings"
)

type NOWPaymentsOperationalSettings struct {
	Enabled     bool                `json:"-"`
	DatabaseURL string              `json:"-"`
	Provider    NOWPaymentsSettings `json:"-"`
}

func (NOWPaymentsOperationalSettings) String() string {
	return "NOWPaymentsOperationalSettings(redacted)"
}
func (s NOWPaymentsOperationalSettings) GoString() string { return s.String() }

func loadNOWPaymentsOperationalSettings(readerDSN, captureDSN string) (NOWPaymentsOperationalSettings, error) {
	raw := os.Getenv("NOWPAYMENTS_OPERATIONAL_ENABLED")
	if raw == "" || raw == "false" {
		return NOWPaymentsOperationalSettings{}, nil
	}
	if raw != "true" || os.Getenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED") != "true" || os.Getenv("NOWPAYMENTS_ENGINE_ENABLED") != "true" || os.Getenv("SERVICE_READ_ONLY") != "true" {
		return NOWPaymentsOperationalSettings{}, errors.New("NOWPayments operations require explicit operational/membership flags and the read-only boundary")
	}
	provider, err := loadNOWPaymentsSettings(false)
	if err != nil || !provider.MembershipsEnabled {
		return NOWPaymentsOperationalSettings{}, errors.New("NOWPayments operational provider configuration unavailable")
	}
	dsn := strings.TrimSpace(os.Getenv("NOWPAYMENTS_OPERATIONAL_DATABASE_URL"))
	parse := func(raw string) (*url.URL, error) {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.User == nil || u.User.Username() == "" || u.Path == "" ||
			len(u.Path) < 2 || len(raw) > 8192 || u.Fragment != "" || (provider.Environment == "production" && u.Query().Get("sslmode") != "verify-full") {
			return nil, errors.New("invalid private database target")
		}
		password, hasPassword := u.User.Password()
		if !hasPassword || password == "" {
			return nil, errors.New("invalid private database target")
		}
		switch strings.Split(u.User.Username(), ".")[0] {
		case "postgres", "app_admin", "pscale_superuser":
			return nil, errors.New("invalid private database login")
		}
		query, err := url.ParseQuery(u.RawQuery)
		if err != nil {
			return nil, errors.New("invalid private database target")
		}
		for key, values := range query {
			if len(values) != 1 || (key != "sslmode" && key != "sslrootcert" && key != "application_name") {
				return nil, errors.New("invalid private database options")
			}
		}
		return u, nil
	}
	target, err := parse(dsn)
	if err != nil {
		return NOWPaymentsOperationalSettings{}, errors.New("NOWPayments operational writer is not configured")
	}
	for _, other := range []string{readerDSN, captureDSN} {
		u, err := parse(other)
		if err != nil || u.Host != target.Host || u.Path != target.Path || u.User.Username() == target.User.Username() {
			return NOWPaymentsOperationalSettings{}, errors.New("NOWPayments operational writer must be separate on the canonical database")
		}
	}
	return NOWPaymentsOperationalSettings{Enabled: true, DatabaseURL: dsn, Provider: provider}, nil
}
