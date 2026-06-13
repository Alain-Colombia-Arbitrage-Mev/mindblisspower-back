// Command vp-payments es el servicio de cobros con Stripe (servicio aparte del
// motor, mismo módulo Go). Expone:
//   - POST /api/payments/checkout  (lo llama el BFF Next con token de servicio)
//   - POST /api/webhooks/stripe    (Stripe → verificado por firma)
//   - GET  /health
//
// En pago exitoso publica NATS `payments.deposit_confirmed`; vp-engine
// (walletbridge) lo consume para postear el ledger y activar el paquete.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vicionpower/vp-engine/internal/payments"
	"github.com/vicionpower/vp-engine/internal/shared/db"
	"github.com/vicionpower/vp-engine/internal/shared/log"
)

var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	if err := run(); err != nil {
		os.Stderr.WriteString("fatal: " + err.Error() + "\n")
		os.Exit(1)
	}
}

func run() error {
	cfg, err := payments.LoadConfig()
	if err != nil {
		return err
	}

	logger := log.New("vp-payments", cfg.LogLevel)
	logger.Info().Str("version", version).Str("commit", commit).Str("env", cfg.Env).Msg("vp-payments starting")

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := db.Open(rootCtx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
	if err != nil {
		return err
	}
	defer pool.Close()
	logger.Info().Int32("max_conns", cfg.DBMaxConns).Msg("postgres pool ready")

	// Activación inline y atómica: el servicio solo necesita DB + Stripe (sin NATS).
	store := payments.NewStore(pool)
	gw := payments.NewStripeGateway(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.SuccessURL, cfg.CancelURL, cfg.StripeProductID, cfg.StripePMConfig, cfg.PaymentMethods)
	handler := payments.NewHandler(store, gw, cfg.ServiceToken, cfg.AdminEmails, cfg.CompanyRootAffiliateID, logger)

	srv := &http.Server{
		Addr:              cfg.HTTPListenAddr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		logger.Info().Str("signal", sig.String()).Msg("shutdown signal received")
		cancel()
	}()

	errCh := make(chan error, 1)
	go func() {
		logger.Info().Str("addr", srv.Addr).Strs("payment_methods", cfg.PaymentMethods).Msg("http server listening")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-rootCtx.Done():
		shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		logger.Info().Msg("http server shutting down")
		return srv.Shutdown(shutdownCtx)
	}
}
