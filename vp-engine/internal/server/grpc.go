// Package server provee gRPC server con connectrpc handler.
// mTLS obligatorio en producción (ADR 0006 §4).
package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// GRPCServer corre HTTP/2 server con connectrpc handlers.
// connectrpc soporta gRPC + gRPC-Web + Connect protocol simultáneamente.
type GRPCServer struct {
	srv     *http.Server
	addr    string
	useTLS  bool
	tlsCfg  *tls.Config
	log     zerolog.Logger
}

// GRPCConfig groups TLS/listen options.
type GRPCConfig struct {
	ListenAddr           string
	TLSCert              string
	TLSKey               string
	TLSClientCA          string
	TLSRequireClientCert bool
}

// NewGRPC creates an HTTP/2 server with the given handler. Caller is responsible
// for mounting connectrpc handlers (e.g., LedgerServiceHandler) on the mux
// before calling Run.
func NewGRPC(cfg GRPCConfig, handler http.Handler, log zerolog.Logger) (*GRPCServer, error) {
	gs := &GRPCServer{
		addr: cfg.ListenAddr,
		log:  log.With().Str("component", "grpc").Logger(),
	}

	useTLS := cfg.TLSCert != "" && cfg.TLSKey != ""

	if useTLS {
		tlsCfg, err := buildTLSConfig(cfg)
		if err != nil {
			return nil, fmt.Errorf("build tls: %w", err)
		}
		gs.tlsCfg = tlsCfg
		gs.useTLS = true
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           h2c.NewHandler(handler, &http2.Server{}),
		TLSConfig:         gs.tlsCfg,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       300 * time.Second,
	}

	gs.srv = srv
	return gs, nil
}

// Run blocks until ctx is cancelled, then shuts down gracefully.
func (s *GRPCServer) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", s.addr, err)
	}

	errCh := make(chan error, 1)
	go func() {
		s.log.Info().Str("addr", s.addr).Bool("tls", s.useTLS).Msg("grpc server listening")
		var err error
		if s.useTLS {
			err = s.srv.ServeTLS(ln, "", "")
		} else {
			err = s.srv.Serve(ln)
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		s.log.Info().Msg("grpc server shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return s.srv.Shutdown(shutdownCtx)
	}
}

func buildTLSConfig(cfg GRPCConfig) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		return nil, fmt.Errorf("load server cert: %w", err)
	}

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{"h2"},
	}

	if cfg.TLSRequireClientCert {
		caBytes, err := os.ReadFile(cfg.TLSClientCA)
		if err != nil {
			return nil, fmt.Errorf("read client ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caBytes) {
			return nil, errors.New("invalid client ca pem")
		}
		tlsCfg.ClientAuth = tls.RequireAndVerifyClientCert
		tlsCfg.ClientCAs = pool
	}

	return tlsCfg, nil
}
