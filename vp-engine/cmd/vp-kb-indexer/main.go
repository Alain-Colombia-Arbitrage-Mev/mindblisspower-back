// Command vp-kb-indexer sincroniza la base de conocimiento del bot de soporte:
// support.kb_chunks (Postgres, fuente de verdad) → Qdrant (índice derivado).
//
// Modos:
//   vp-kb-indexer                     # loop incremental cada KB_POLL_INTERVAL
//   vp-kb-indexer --once              # una pasada incremental y sale (cron/CI)
//   vp-kb-indexer --rebuild           # recrea la colección y re-embebe TODO
//   vp-kb-indexer --query "pregunta"  # smoke test: busca como rol member
//
// Embeddings: intfloat/multilingual-e5-large vía OpenRouter (key en el
// secreto OPENROUTER_API_RAG de Secrets Manager → env OPENROUTER_API_KEY).
package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"syscall"

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
	rebuild := flag.Bool("rebuild", false, "recrear la colección Qdrant y re-embeber todo")
	once := flag.Bool("once", false, "una pasada incremental y salir")
	query := flag.String("query", "", "smoke test: buscar como rol member y salir")
	flag.Parse()

	cfg, err := supportkb.LoadConfig()
	if err != nil {
		return err
	}

	logger := log.New("vp-kb-indexer", cfg.LogLevel)
	logger.Info().Str("version", version).Str("commit", commit).
		Str("model", supportkb.EmbedModel).Int("dims", supportkb.EmbedDims).
		Str("collection", cfg.Collection).Msg("vp-kb-indexer starting")

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		logger.Info().Str("signal", sig.String()).Msg("shutdown signal received")
		cancel()
	}()

	pool, err := db.Open(rootCtx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnLifetime)
	if err != nil {
		return err
	}
	defer pool.Close()

	emb := supportkb.NewEmbedder(cfg.OpenRouterAPIKey, cfg.OpenRouterURL)
	qd := supportkb.NewQdrant(cfg.QdrantURL, cfg.QdrantAPIKey, cfg.Collection)

	// Valida dims de la colección contra el modelo ANTES de tocar nada:
	// un mismatch aborta el arranque (requiere --rebuild explícito).
	if !*rebuild {
		if err := qd.EnsureCollection(rootCtx); err != nil {
			return err
		}
	}

	ix := supportkb.NewIndexer(pool, emb, qd, cfg.BatchSize, logger)

	if *query != "" {
		hits, qerr := supportkb.NewSearcher(emb, qd).Search(rootCtx, *query, supportkb.SearchOpts{
			Visibility: supportkb.VisibilityFor("member"),
			Lang:       "es",
			TopK:       5,
		})
		if qerr != nil {
			return qerr
		}
		for _, h := range hits {
			logger.Info().Float64("score", h.Score).Str("titulo", h.Titulo).
				Str("categoria", h.Categoria).Int("ord", h.Ord).Str("texto", h.Texto).Msg("hit")
		}
		logger.Info().Int("hits", len(hits)).Msg("búsqueda completa")
		return nil
	}

	switch {
	case *rebuild:
		n, err := ix.Rebuild(rootCtx)
		if err != nil {
			return err
		}
		logger.Info().Int("chunks", n).Msg("rebuild completo")
		return nil
	case *once:
		n, err := ix.RunOnce(rootCtx)
		if err != nil {
			return err
		}
		logger.Info().Int("chunks", n).Msg("pasada completa")
		return nil
	default:
		logger.Info().Dur("interval", cfg.PollInterval).Msg("loop incremental iniciado")
		ix.Loop(rootCtx, cfg.PollInterval)
		return nil
	}
}
