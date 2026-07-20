// Command vp-withdrawals es la API HTTP de retiros:
//   - POST /api/payments/withdraw          solicitud del miembro
//   - GET  /api/admin/withdrawals          cola admin
//   - POST /api/admin/withdrawals/action   approve|reject|pay|cancel
//   - GET  /health
//
// Comparte la base RDS con vp-payments: el débito contable y el cambio de
// estado siguen ocurriendo en UNA sola transacción de Postgres.
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
	"github.com/vicionpower/vp-engine/internal/withdrawals"
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
	cfg, err := withdrawals.LoadConfig()
	if err != nil {
		return err
	}

	logger := log.New("vp-withdrawals", cfg.LogLevel)
	logger.Info().Str("version", version).Str("commit", commit).Str("env", cfg.Env).
		Msg("vp-withdrawals starting")

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := db.Open(rootCtx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
	if err != nil {
		return err
	}
	defer pool.Close()

	store := withdrawals.NewStore(pool)
	store.SetLogger(logger)
	handler := withdrawals.NewHandler(store, cfg.ServiceToken, cfg.AdminEmails, logger)
	handler.SetSuperAdmins(cfg.SuperAdminEmails)

	// Verificación BMP. Sin credenciales el servicio sigue arriba: la solicitud
	// se registra marcada 'unavailable' (fail-open) y el candado al pagar la
	// re-verifica. Se avisa fuerte porque en producción es una mala config.
	if cfg.BMPClientID != "" && cfg.BMPClientSecret != "" {
		handler.SetBMPClient(withdrawals.NewBMPClient(cfg.BMPBaseURL, cfg.BMPClientID, cfg.BMPClientSecret))
		logger.Info().Str("bmp_base_url", cfg.BMPBaseURL).Msg("BMP verification enabled")
	} else {
		logger.Warn().Msg("BMP_CLIENT_ID/SECRET ausentes: verificación BMP deshabilitada")
	}

	// Misma defensa H-2 que vp-payments: re-verificar el id token Cognito.
	if jwksURL := cfg.JWKSURL(); jwksURL != "" {
		verifier, verr := payments.NewCognitoVerifier(rootCtx, jwksURL, cfg.CognitoIssuer, cfg.CognitoClientID)
		if verr != nil {
			logger.Warn().Err(verr).
				Msg("id-token verifier init failed; identidad SIN verificar: se confía en el email declarado por el llamador")
		} else {
			handler.SetIdentityVerifier(verifier, false)
			logger.Info().Str("issuer", cfg.CognitoIssuer).Msg("id-token identity verification enabled")
		}
	} else {
		// No es fail-closed: requireVerified queda en false, así que resolveIdentity
		// acepta el email declarado (query/body) sin verificarlo. Cualquiera con el
		// token de servicio puede hacerse pasar por admin. Paridad intencional con
		// vp-payments y vp-support hasta que el rollout estricto de los BFFs permita
		// exigir el header X-VP-Id-Token.
		logger.Warn().Msg("COGNITO_ISSUER no configurado; identidad SIN verificar: se confía en el email declarado por el llamador")
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

	errCh := make(chan error, 1)
	go func() {
		logger.Info().Str("addr", srv.Addr).Msg("http server listening")
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
