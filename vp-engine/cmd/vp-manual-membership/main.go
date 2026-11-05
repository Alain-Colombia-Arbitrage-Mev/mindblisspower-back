// vp-manual-membership is an explicit local operator, not an HTTP service.
// It accepts one bounded instruction on stdin. Never pass a DSN in arguments.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/vicionpower/vp-engine/internal/manualmembership"
)

var errOperator = errors.New("manual_membership_operator_failed")

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Getenv); err != nil {
		// No SQL diagnostics, connection strings, instruction body or credentials.
		fmt.Fprintln(os.Stderr, "manual_membership_operator_failed")
		os.Exit(1)
	}
}

func readInstruction(reader io.Reader) (manualmembership.Input, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, 65537))
	if err != nil || len(raw) > 65536 {
		return manualmembership.Input{}, errOperator
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var in manualmembership.Input
	if err := decoder.Decode(&in); err != nil {
		return in, errOperator
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || manualmembership.ValidateInput(in) != nil {
		return in, errOperator
	}
	// Reject duplicate top-level fields as well as unknown/trailing JSON. The
	// input values have already been checked against the typed contract above.
	keys := json.NewDecoder(bytes.NewReader(raw))
	if token, err := keys.Token(); err != nil || token != json.Delim('{') {
		return in, errOperator
	}
	seen := map[string]bool{}
	allowed := map[string]bool{"expected_database": true, "id": true, "operation_key": true,
		"person_id": true, "affiliate_id": true, "person_public_id": true, "package_id": true,
		"authorization_digest": true, "actor_reason": true, "authority": true, "expected_affiliate_sha256": true}
	for keys.More() {
		token, err := keys.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] || seen[key] {
			return in, errOperator
		}
		seen[key] = true
		var value json.RawMessage
		if err := keys.Decode(&value); err != nil {
			return in, errOperator
		}
	}
	return in, nil
}

func operatorConfig(dsn, ca string, expectedDatabase string) (*pgxpool.Config, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.User == nil || u.User.Username() == "" || u.Fragment != "" {
		return nil, errOperator
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query["sslmode"]) != 1 || query.Get("sslmode") != "verify-full" {
		return nil, errOperator
	}
	for key := range query {
		switch key {
		case "sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout":
		default:
			return nil, errOperator
		}
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Database != expectedDatabase || cfg.ConnConfig.TLSConfig == nil || cfg.ConnConfig.TLSConfig.InsecureSkipVerify {
		return nil, errOperator
	}
	if ca != "" {
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM([]byte(ca)) {
			return nil, errOperator
		}
		cfg.ConnConfig.TLSConfig.RootCAs = roots
	}
	cfg.ConnConfig.TLSConfig.MinVersion = tls.VersionTLS12
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams = map[string]string{"timezone": "UTC", "application_name": "manual-membership-reviewed-operator"}
	cfg.MaxConns, cfg.MinConns = 1, 0
	cfg.MaxConnLifetime = 5 * time.Minute
	return cfg, nil
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer, getenv func(string) string) error {
	flags := flag.NewFlagSet("vp-manual-membership", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	apply := flags.Bool("apply-authorized", false, "apply one explicit reviewed instruction")
	preflight := flags.Bool("preflight", false, "read-only metadata check")
	root := flags.Int64("root-id", 0, "explicit company root affiliate")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *root <= 0 || *apply == *preflight {
		return errOperator
	}
	in, err := readInstruction(stdin)
	if err != nil {
		return errOperator
	}
	cfg, err := operatorConfig(getenv("MANUAL_MEMBERSHIP_DATABASE_URL"), getenv("MANUAL_MEMBERSHIP_DATABASE_CA_PEM"), in.ExpectedDatabase)
	if err != nil {
		return errOperator
	}
	deadline, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(deadline, cfg)
	if err != nil {
		return errOperator
	}
	defer pool.Close()
	service := manualmembership.New(pool, *root)
	if *preflight {
		result, err := service.Preflight(deadline, in)
		if err != nil {
			return errOperator
		}
		return json.NewEncoder(stdout).Encode(result)
	}
	result, err := service.Apply(deadline, in)
	if err != nil {
		return errOperator
	}
	// Receipt contains no email, phone, password, OTP, actor reason or DSN. IDs
	// belong only in the operator's private evidence, not a public chat/log.
	return json.NewEncoder(stdout).Encode(struct {
		Applied      bool      `json:"applied"`
		Replay       bool      `json:"replay"`
		SourceID     string    `json:"source_id"`
		PV           int       `json:"pv"`
		PrincipalUSD string    `json:"principal_usd"`
		NetUSD       string    `json:"net_usd"`
		EffectiveAt  time.Time `json:"effective_at"`
		MaturesAt    time.Time `json:"matures_at"`
	}{true, result.Replay, result.ID, 100, "100.00", "97.00", result.EffectiveAt, result.MaturesAt})
}
