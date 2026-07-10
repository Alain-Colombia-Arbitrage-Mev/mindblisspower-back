// Command vp-support es la API HTTP del soporte con IA (RAG sobre la KB):
//   - POST   /api/support/chat            bot RAG (escalate ⇒ Chatwoot)
//   - POST   /api/support/kb/search       búsqueda directa (scoped por rol)
//   - POST   /api/support/kb/docs         alta/edición de documento (admin)
//   - GET    /api/support/kb/docs         listado con estado de indexación (admin)
//   - DELETE /api/support/kb/docs/{id}    desactivar (admin; el indexer purga Qdrant)
//   - GET    /health
//
// Postgres es la fuente de verdad de la KB; vp-kb-indexer (proceso aparte)
// sincroniza a Qdrant. Este servicio solo LEE Qdrant y ESCRIBE Postgres.
// Embeddings y chat salen por OpenRouter (secreto OPENROUTER_API_RAG).
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
	"github.com/vicionpower/vp-engine/internal/supportkb"
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
	cfg, err := supportkb.LoadServiceConfig()
	if err != nil {
		return err
	}

	logger := log.New("vp-support", cfg.LogLevel)
	logger.Info().Str("version", version).Str("commit", commit).Str("env", cfg.Env).
		Str("chat_model", cfg.ChatModel).Str("collection", cfg.Collection).Msg("vp-support starting")

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := db.Open(rootCtx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
	if err != nil {
		return err
	}
	defer pool.Close()

	emb := supportkb.NewEmbedder(cfg.OpenRouterAPIKey, cfg.OpenRouterURL)
	qd := supportkb.NewQdrant(cfg.QdrantURL, cfg.QdrantAPIKey, cfg.Collection)
	if err := qd.EnsureCollection(rootCtx); err != nil {
		// Qdrant caído al arrancar no debe impedir gestionar documentos:
		// warn y seguir; search/chat degradan con error controlado.
		logger.Warn().Err(err).Msg("Qdrant no disponible al arrancar (search/chat degradados)")
	}

	searcher := supportkb.NewSearcher(emb, qd)
	bot := supportkb.NewBot(searcher, cfg.OpenRouterAPIKey, cfg.ChatURL, cfg.ChatModel, cfg.MinScore)
	handler := supportkb.NewHandler(pool, searcher, bot, cfg.ServiceToken, cfg.AdminEmails, logger)

	// Misma defensa H-2 que vp-payments: re-verificar el id token Cognito.
	if jwksURL := cfg.JWKSURL(); jwksURL != "" {
		verifier, verr := payments.NewCognitoVerifier(rootCtx, jwksURL, cfg.CognitoIssuer, cfg.CognitoClientID)
		if verr != nil {
			logger.Warn().Err(verr).Msg("id-token verifier init failed; fallback sin verificar (rol admin deshabilitado)")
		} else {
			handler.SetIdentityVerifier(verifier, false)
			logger.Info().Str("issuer", cfg.CognitoIssuer).Msg("id-token identity verification enabled")
		}
	} else {
		logger.Warn().Msg("COGNITO_ISSUER no configurado; el rol admin queda deshabilitado (fail-closed)")
	}

	srv := &http.Server{
		Addr:              cfg.HTTPListenAddr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      90 * time.Second, // chat incluye una llamada LLM
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
