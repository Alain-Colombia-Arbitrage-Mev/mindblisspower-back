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
	store.EngineURL = cfg.EngineURL // simulador canónico de θ (lock de solvencia)
	if cfg.ReadDatabaseURL != "" {
		readPool, rerr := db.Open(rootCtx, cfg.ReadDatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
		if rerr != nil {
			logger.Warn().Err(rerr).Msg("réplica de lectura inalcanzable; reads van al primary")
		} else {
			defer readPool.Close()
			store.SetReadPool(readPool)
			logger.Info().Msg("réplica de lectura habilitada (reads → replica)")
		}
	}
	if cache := payments.NewCache(cfg.RedisAddr, cfg.RedisPassword); cache != nil {
		if err := cache.Ping(rootCtx); err != nil {
			logger.Warn().Err(err).Str("addr", cfg.RedisAddr).Msg("Redis inalcanzable; caché deshabilitada (degrada a DB)")
		} else {
			store.SetCache(cache)
			logger.Info().Str("addr", cfg.RedisAddr).Msg("Redis cache-aside habilitado")
		}
	}
	gw := payments.NewStripeGateway(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.SuccessURL, cfg.CancelURL, cfg.StripeProductID, cfg.StripePMConfig, cfg.PaymentMethods)
	handler := payments.NewHandler(store, gw, cfg.ServiceToken, cfg.AdminEmails, cfg.CompanyRootAffiliateID, logger)

	// Verificación independiente de identidad (defensa en profundidad, H-2): el
	// backend re-verifica el id token Cognito que reenvía el BFF en X-VP-Id-Token,
	// en lugar de confiar en el `email` que envía el cliente. El token de servicio
	// sigue siendo requerido (segundo factor). En modo REQUIRE_VERIFIED_IDENTITY=false
	// (default) el header es opcional y hay fallback backward-compatible.
	if jwksURL := cfg.JWKSURL(); jwksURL != "" {
		verifier, verr := payments.NewCognitoVerifier(rootCtx, jwksURL, cfg.CognitoIssuer, cfg.CognitoClientID)
		if verr != nil {
			// Sin verificador: si el modo estricto está activo, no podemos arrancar
			// de forma segura; si no, degradamos al fallback con warning.
			if cfg.RequireVerifiedIdentity {
				return verr
			}
			logger.Warn().Err(verr).Str("jwks", jwksURL).Msg("id-token verifier init failed; running in unverified-fallback mode")
		} else {
			handler.SetIdentityVerifier(verifier, cfg.RequireVerifiedIdentity)
			logger.Info().Str("issuer", cfg.CognitoIssuer).Bool("require_verified", cfg.RequireVerifiedIdentity).Msg("id-token identity verification enabled")
		}
	} else {
		if cfg.RequireVerifiedIdentity {
			return errors.New("REQUIRE_VERIFIED_IDENTITY=true but Cognito issuer/user-pool not configured")
		}
		logger.Warn().Msg("Cognito issuer/user-pool not configured; id-token verification disabled (unverified-fallback mode)")
	}

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

	// Alert evaluator: runs every 5 minutes, non-fatal — an evaluator error must
	// never crash the service.
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		alertLog := logger.With().Str("component", "alert-evaluator").Logger()
		alertLog.Info().Msg("alert evaluator started (every 5m)")
		for {
			select {
			case <-rootCtx.Done():
				alertLog.Info().Msg("alert evaluator stopped")
				return
			case <-ticker.C:
				open, evalErr := store.EvaluateAlerts(rootCtx)
				if evalErr != nil {
					alertLog.Error().Err(evalErr).Msg("EvaluateAlerts failed (non-fatal)")
				} else {
					alertLog.Info().Int("open_alerts", open).Msg("alert evaluation complete")
				}
			}
		}
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
