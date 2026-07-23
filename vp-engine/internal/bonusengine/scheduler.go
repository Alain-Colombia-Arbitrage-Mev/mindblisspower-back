// Scheduler: gocron jobs del bonusengine.
//
// Jobs registrados:
//  1. binary-period-cycle — lunes 02:00 America/Bogota (ADR 0012 §5)
//     cierra el período recién terminado y abre el siguiente.
//  2. invariant-check     — cada 60s, llama Invariants.Run.
//
// gocron v2 propaga ctx — al cancelar rootCtx en main.go, los jobs en vuelo
// terminan limpios.
package bonusengine

import (
	"context"
	"fmt"
	"time"

	"github.com/go-co-op/gocron/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// Scheduler agrupa los jobs periódicos del motor.
type Scheduler struct {
	sched              gocron.Scheduler
	engine             *Engine
	invs               *Invariants
	db                 *pgxpool.Pool
	log                zerolog.Logger
	binaryCycleEnabled bool
}

// NewScheduler crea el scheduler en zona Bogota. Aun no arranca; llamar Run.
func NewScheduler(engine *Engine, invs *Invariants, db *pgxpool.Pool, log zerolog.Logger, binaryCycleEnabled bool) (*Scheduler, error) {
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		return nil, fmt.Errorf("load Bogota tz: %w", err)
	}
	s, err := gocron.NewScheduler(gocron.WithLocation(loc))
	if err != nil {
		return nil, fmt.Errorf("new gocron scheduler: %w", err)
	}
	return &Scheduler{
		sched:              s,
		engine:             engine,
		invs:               invs,
		db:                 db,
		log:                log.With().Str("component", "scheduler").Logger(),
		binaryCycleEnabled: binaryCycleEnabled,
	}, nil
}

// Run arranca el scheduler y bloquea hasta ctx cancelled.
// Registra los jobs y retorna error si alguno no se pudo registrar.
func (s *Scheduler) Run(ctx context.Context) error {
	if s.binaryCycleEnabled {
		// Job 1: ciclo de periodo binario — lunes 02:00 Bogota.
		_, err := s.sched.NewJob(
			gocron.CronJob("0 2 * * 1", false), // false = sin segundos
			gocron.NewTask(func(jobCtx context.Context) {
				s.runBinaryCycle(jobCtx)
			}, ctx),
			gocron.WithName("binary-period-cycle"),
			gocron.WithSingletonMode(gocron.LimitModeReschedule),
		)
		if err != nil {
			return fmt.Errorf("register binary-period-cycle: %w", err)
		}
	} else {
		s.log.Warn().Msg("binary period cycle disabled; invariant monitor remains active")
	}

	// Job 2: chequeo de invariantes — cada 60s
	_, err := s.sched.NewJob(
		gocron.DurationJob(60*time.Second),
		gocron.NewTask(func(jobCtx context.Context) {
			s.invs.Run(jobCtx)
		}, ctx),
		gocron.WithName("invariant-check"),
		gocron.WithSingletonMode(gocron.LimitModeReschedule),
		gocron.WithStartAt(gocron.WithStartImmediately()),
	)
	if err != nil {
		return fmt.Errorf("register invariant-check: %w", err)
	}

	// Job 3: devengo diario de ROI de CDs — 00:30 Bogota. Independiente del ciclo
	// binario: el ROI (CD para todos) corre aunque el cierre binario esté apagado.
	_, err = s.sched.NewJob(
		gocron.CronJob("30 0 * * *", false),
		gocron.NewTask(func(jobCtx context.Context) {
			s.runCDROI(jobCtx)
		}, ctx),
		gocron.WithName("cd-roi-daily"),
		gocron.WithSingletonMode(gocron.LimitModeReschedule),
	)
	if err != nil {
		return fmt.Errorf("register cd-roi-daily: %w", err)
	}

	s.sched.Start()
	s.log.Info().Msg("scheduler started")

	<-ctx.Done()
	s.log.Info().Msg("scheduler shutting down")
	return s.sched.Shutdown()
}

// runCDROI ejecuta el devengo diario de ROI de los CDs activos.
func (s *Scheduler) runCDROI(ctx context.Context) {
	log := s.log.With().Str("job", "cd-roi-daily").Logger()
	if err := s.engine.RunROIDaily(ctx); err != nil {
		log.Error().Err(err).Msg("CD ROI daily accrual failed")
		return
	}
	s.engine.lastROIRun.SetToCurrentTime()
}

// runBinaryCycle: cierra el período abierto (si lo hay) y abre el siguiente.
// Idempotente: si no hay período open, CloseBinaryPeriod retorna sin pagar;
// fn_open_next_binary_period también es idempotente por UNIQUE(period_start, period_end).
func (s *Scheduler) runBinaryCycle(ctx context.Context) {
	log := s.log.With().Str("job", "binary-period-cycle").Logger()
	log.Info().Msg("starting weekly binary cycle")

	// 1. Cerrar el período actualmente open (el que acaba de terminar).
	openPeriodID, err := pickPeriodToClose(ctx, s.db)
	if err != nil {
		log.Warn().Err(err).Msg("no open period to close (may be first run)")
	} else {
		if err := s.engine.CloseBinaryPeriod(ctx, openPeriodID); err != nil {
			log.Error().Err(err).Int64("period_id", openPeriodID).Msg("CloseBinaryPeriod failed")
			// No abortamos el ciclo — abrimos el próximo igualmente para no
			// quedarnos sin período activo. Operaciones revisará el período fallido.
		} else {
			log.Info().Int64("period_id", openPeriodID).Msg("period closed")
			s.engine.lastBinaryClose.SetToCurrentTime()
		}
	}

	// 2. Abrir el siguiente período.
	var newPeriodID int64
	err = s.db.QueryRow(ctx,
		"SELECT mlm.fn_open_next_binary_period()").Scan(&newPeriodID)
	if err != nil {
		log.Error().Err(err).Msg("fn_open_next_binary_period failed")
		return
	}
	log.Info().Int64("period_id", newPeriodID).Msg("next period open")
}

// pickPeriodToClose elige el período abierto que YA terminó (period_end <= now()).
//
// La guarda `period_end <= now()` evita una race entre-boxes: runBinaryCycle corre
// en 2 boxes el lunes 02:00 sin lock cross-box para la SELECCIÓN (el
// pg_advisory_xact_lock de CloseBinaryPeriod sólo protege el cierre de un periodID
// dado, no cuál se elige). Sin la guarda, si el box A ya cerró el período terminado
// y abrió el de la semana en curso (period_end futuro), el box B rezagado vería ese
// nuevo período como el único 'open' y lo cerraría prematuramente, dejando la semana
// sin período. Con la guarda, el período recién abierto (period_end futuro) nunca se
// elige; sólo se cierra el que realmente terminó. Retorna pgx.ErrNoRows si no hay
// ninguno terminado por cerrar (p. ej. sólo existe el de la semana en curso).
func pickPeriodToClose(ctx context.Context, db *pgxpool.Pool) (int64, error) {
	var id int64
	err := db.QueryRow(ctx,
		"SELECT id FROM mlm.binary_period WHERE status = 'open' AND period_end <= now() "+
			"ORDER BY period_end ASC LIMIT 1").Scan(&id)
	return id, err
}
