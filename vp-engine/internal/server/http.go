// Package server provee HTTP server para /health, /ready y /metrics
// (separado del gRPC server).
package server

import (
	"context"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"

	"github.com/vicionpower/vp-engine/internal/shared/metrics"
)

// ReadinessProbe valida que el proceso está listo para servir tráfico.
// Retornar error ⇒ /ready devuelve 503. Llamada en cada request, debe ser
// barata (DB ping + lecturas atómicas).
//
// Wired en main.go: combina pool.Ping + Invariants.Status.
type ReadinessProbe func(ctx context.Context) error

// HTTPServer expone health check + métricas Prometheus.
type HTTPServer struct {
	srv             *http.Server
	log             zerolog.Logger
	ready           ReadinessProbe
	networkAnalysis http.Handler
}

type HTTPOption func(*HTTPServer)

func WithNetworkAnalysis(handler http.Handler) HTTPOption {
	return func(s *HTTPServer) {
		s.networkAnalysis = handler
	}
}

// NewHTTP construye el server. ready puede ser nil (en cuyo caso /ready
// devuelve 200 incondicional — solo para tests).
func NewHTTP(addr string, ready ReadinessProbe, log zerolog.Logger, opts ...HTTPOption) *HTTPServer {
	s := &HTTPServer{
		log:   log.With().Str("component", "http").Logger(),
		ready: ready,
	}
	for _, opt := range opts {
		opt(s)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/ready", s.readyHandler)
	mux.Handle("/metrics", promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{
		EnableOpenMetrics: true,
	}))
	if s.networkAnalysis != nil {
		mux.Handle("/network/analyze", s.networkAnalysis)
		mux.Handle("/api/network/analyze", s.networkAnalysis)
	}

	s.srv = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return s
}

// Run blocks until ctx is cancelled, then shuts down gracefully.
func (s *HTTPServer) Run(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() {
		s.log.Info().Str("addr", s.srv.Addr).Msg("http server listening")
		if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		s.log.Info().Msg("http server shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.srv.Shutdown(shutdownCtx)
	}
}

// /health: liveness probe. Solo confirma que el proceso vive.
// K8s lo usa para decidir si reiniciar el pod. Debe ser O(1).
func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// /ready: readiness probe. Confirma que podemos servir tráfico real.
// K8s lo usa para sacar el pod de rotación. Chequea: DB ping + invariantes T1-T4.
func (s *HTTPServer) readyHandler(w http.ResponseWriter, r *http.Request) {
	if s.ready == nil {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.ready(ctx); err != nil {
		s.log.Warn().Err(err).Msg("readiness probe failed")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready: " + err.Error()))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}
