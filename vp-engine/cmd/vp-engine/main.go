// Command vp-engine is the entry point.
// Wires config → DB → NATS → tracing → modules → servers.
// Graceful shutdown on SIGINT/SIGTERM con context cancellation propagado.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"golang.org/x/sync/errgroup"

	"github.com/vicionpower/vp-engine/internal/bonusengine"
	"github.com/vicionpower/vp-engine/internal/ledger"
	"github.com/vicionpower/vp-engine/internal/networkintel"
	"github.com/vicionpower/vp-engine/internal/server"
	"github.com/vicionpower/vp-engine/internal/shared/config"
	"github.com/vicionpower/vp-engine/internal/shared/db"
	"github.com/vicionpower/vp-engine/internal/shared/log"
	"github.com/vicionpower/vp-engine/internal/shared/tracing"
	"github.com/vicionpower/vp-engine/internal/walletbridge"
	"github.com/vicionpower/vp-engine/proto/gen/go/vicionpower/v1/vicionpowerv1connect"
)

// Set by ldflags at build time.
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	if err := run(); err != nil {
		// Logger may not be initialized yet; print to stderr as last resort.
		os.Stderr.WriteString("fatal: " + err.Error() + "\n")
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger := log.New(cfg.ServiceName, cfg.LogLevel)
	logger.Info().Str("version", version).Str("commit", commit).Str("env", cfg.Env).Msg("vp-engine starting")

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Tracing
	otelShutdown, err := tracing.Init(rootCtx, cfg.ServiceName, cfg.OTLPEndpoint, cfg.OTLPHeaders)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = otelShutdown(shutdownCtx)
	}()

	// Database
	pool, err := db.Open(rootCtx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
	if err != nil {
		return err
	}
	defer pool.Close()
	logger.Info().Int32("max_conns", cfg.DBMaxConns).Msg("postgres pool ready")

	// NATS opcional: si está vacío o inalcanzable, el motor sigue SIN NATS
	// (walletbridge queda no-op y los eventos se deshabilitan). No es fatal:
	// el devengo de ROI y los invariantes no dependen de NATS.
	var nc *nats.Conn
	if cfg.NATSURL != "" {
		nc, err = connectNATS(cfg)
		if err != nil {
			logger.Warn().Err(err).Str("url", cfg.NATSURL).Msg("NATS inalcanzable; el motor continúa sin NATS (walletbridge no-op)")
			nc = nil
		} else {
			defer nc.Drain()
			logger.Info().Str("url", cfg.NATSURL).Msg("nats connected")
		}
	} else {
		logger.Warn().Msg("NATS_URL empty; running without NATS (events disabled)")
	}

	// Modules
	ledgerSvc := ledger.New(pool, nc, logger)
	engine := bonusengine.New(pool, nc, logger, bonusengine.WithTimezone(cfg.BonusEngineTimezone))
	bridge := walletbridge.New(pool, nc, logger)
	invariants := bonusengine.NewInvariants(pool, logger)
	scheduler, err := bonusengine.NewScheduler(engine, invariants, pool, logger, cfg.BonusEngineBinaryCycleEnabled)
	if err != nil {
		return err
	}
	logger.Info().Bool("binary_cycle_enabled", cfg.BonusEngineBinaryCycleEnabled).Msg("bonus engine scheduler configured")

	// gRPC mux + LedgerService handler
	grpcMux := http.NewServeMux()
	ledgerPath, ledgerHandler := vicionpowerv1connect.NewLedgerServiceHandler(ledgerSvc)
	grpcMux.Handle(ledgerPath, ledgerHandler)
	logger.Info().Str("path", ledgerPath).Msg("ledger service mounted")

	grpcSrv, err := server.NewGRPC(server.GRPCConfig{
		ListenAddr:           cfg.GRPCListenAddr,
		TLSCert:              cfg.GRPCTLSCert,
		TLSKey:               cfg.GRPCTLSKey,
		TLSClientCA:          cfg.GRPCTLSClientCA,
		TLSRequireClientCert: cfg.GRPCTLSRequireClientCert,
	}, grpcMux, logger)
	if err != nil {
		return err
	}

	// Readiness probe: pool.Ping (DB vivo) + invariantes T1-T4 todas en OK.
	readiness := func(ctx context.Context) error {
		if err := pool.Ping(ctx); err != nil {
			return err
		}
		return invariants.Status()
	}
	networkAnalyzer := networkintel.NewHandler(networkintel.NewOpenRouterClient(networkintel.OpenRouterConfig{
		APIKey:        cfg.OpenRouterAPIKey,
		Model:         cfg.OpenRouterModel,
		FallbackModel: cfg.OpenRouterFallbackModel,
		Endpoint:      cfg.OpenRouterEndpoint,
		Referer:       cfg.OpenRouterReferer,
		AppTitle:      cfg.OpenRouterAppTitle,
	}), logger)
	httpSrv := server.NewHTTP(cfg.HTTPListenAddr, readiness, logger, server.WithNetworkAnalysis(networkAnalyzer))

	// Signal handling → cancel rootCtx
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		logger.Info().Str("signal", sig.String()).Msg("shutdown signal received")
		cancel()
	}()

	// errgroup: si cualquier servidor falla, todos paran
	g, gctx := errgroup.WithContext(rootCtx)

	g.Go(func() error { return grpcSrv.Run(gctx) })
	g.Go(func() error { return httpSrv.Run(gctx) })
	g.Go(func() error { return bridge.Run(gctx) })
	g.Go(func() error { return scheduler.Run(gctx) })

	if err := g.Wait(); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}

	logger.Info().Msg("vp-engine shutdown complete")
	return nil
}

func connectNATS(cfg *config.Config) (*nats.Conn, error) {
	opts := []nats.Option{
		nats.Name("vp-engine"),
		nats.Timeout(5 * time.Second),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2 * time.Second),
		nats.PingInterval(20 * time.Second),
	}
	if cfg.NATSUser != "" {
		opts = append(opts, nats.UserInfo(cfg.NATSUser, cfg.NATSPassword))
	}
	return nats.Connect(cfg.NATSURL, opts...)
}
