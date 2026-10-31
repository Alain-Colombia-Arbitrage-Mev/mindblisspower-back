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
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/nowengine"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
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
	store.SetLogger(logger)         // best-effort: comprobantes de compra, eventos
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
	var gw *payments.StripeGateway
	if cfg.ExternalProvidersEnabled() {
		// Only an explicitly configured development/test environment permits test captures.
		// cfg.Env defaults to development for local ergonomics; it is not proof of opt-in.
		gw = payments.NewStripeGateway(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.SuccessURL, cfg.CancelURL, cfg.StripeProductID, cfg.StripePMConfig, cfg.PaymentMethods, os.Getenv("ENV"))
	}
	handler := payments.NewHandler(store, gw, cfg.ServiceToken, cfg.AdminEmails, cfg.CompanyRootAffiliateID, logger)
	handler.SetStripeCheckoutEnabled(cfg.StripeCheckoutEnabled)
	if cfg.NOWPaymentsCapture.Enabled {
		capturePool, captureErr := db.Open(rootCtx, cfg.NOWPaymentsCapture.DatabaseURL, 2, cfg.DBConnLifetime)
		if captureErr != nil {
			return errors.New("NOWPayments capture database unavailable")
		}
		defer capturePool.Close()
		var readerRole, captureRole string
		if err := pool.QueryRow(rootCtx, `SELECT current_user`).Scan(&readerRole); err != nil {
			return errors.New("cannot verify payments reader role")
		}
		if err := capturePool.QueryRow(rootCtx, `SELECT current_user`).Scan(&captureRole); err != nil || readerRole == captureRole {
			return errors.New("NOWPayments capture requires a distinct restricted database login")
		}
		captureClient, captureErr := nowpayments.New(cfg.NOWPaymentsCapture.Client)
		if captureErr != nil {
			return captureErr
		}
		if err := handler.SetNOWPaymentsCapture(captureClient, payments.NewNOWPaymentsCaptureStore(capturePool), cfg.NOWPaymentsCapture.Client.Environment); err != nil {
			return err
		}
		logger.Info().Msg("NOWPayments signed notification capture enabled; checkout and financial activation unchanged")
	}
	if cfg.ExternalProvidersEnabled() && cfg.NOWPayments.MembershipsEnabled {
		nowClient, nowErr := nowpayments.New(cfg.NOWPayments.ClientConfig())
		if nowErr != nil {
			return nowErr
		}
		if err := handler.SetNOWPayments(nowClient, cfg.NOWPayments.Environment, cfg.NOWPayments.CallbackURL, cfg.NOWPayments.SuccessURL, cfg.NOWPayments.CancelURL); err != nil {
			return err
		}
		logger.Info().Msg("NOWPayments membership checkout explicitly enabled; financial readiness guards still apply")
	}
	if cfg.NOWPaymentsOperational.Enabled {
		settings := cfg.NOWPaymentsOperational
		operationalPool, opErr := db.Open(rootCtx, settings.DatabaseURL, 2, cfg.DBConnLifetime)
		if opErr != nil {
			return errors.New("NOWPayments operational database unavailable")
		}
		defer operationalPool.Close()
		var readerRole, writerRole string
		if err := pool.QueryRow(rootCtx, `SELECT current_user`).Scan(&readerRole); err != nil {
			return errors.New("NOWPayments reader role unavailable")
		}
		if err := operationalPool.QueryRow(rootCtx, `SELECT current_user`).Scan(&writerRole); err != nil || readerRole == writerRole {
			return errors.New("NOWPayments requires a separate operational writer")
		}
		client, opErr := nowpayments.New(settings.Provider.ClientConfig())
		if opErr != nil {
			return opErr
		}
		operationalStore := payments.NewNOWPaymentsOperationalStore(operationalPool)
		engine := nowengine.New(operationalPool, cfg.CompanyRootAffiliateID)
		operationalStore.SetNOWOperationalReadiness(engine.ValidateReady)
		handler.SetNOWOperationalReadinessRunner(func(ctx context.Context) error {
			tx, err := operationalPool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			if err := engine.ValidateReady(ctx, tx); err != nil {
				return err
			}
			return tx.Commit(ctx)
		})
		if err := handler.SetNOWPaymentsOperational(client, operationalStore, settings.Provider); err != nil {
			return err
		}
		handler.SetNOWOperationalJobRunner(func(ctx context.Context) (int, error) {
			jobsCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			processed, deliveryErr := operationalStore.RunNOWOperationalJobs(jobsCtx, 5)
			cancel()
			// A held/retrying delivery must not starve already active members.
			return processed, errors.Join(deliveryErr, engine.Run(ctx))
		})
		// One bounded worker, not one goroutine per notification. Database jobs
		// and leases survive restarts; the private scheduled wake-up catches up
		// while the container was asleep. A shared mutex coalesces concurrent runs.
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				if _, err := handler.RunNOWOperationalJobs(rootCtx); err != nil && rootCtx.Err() == nil {
					logger.Warn().Msg("NOWPayments durable processing requires retry")
				}
				select {
				case <-rootCtx.Done():
					return
				case <-ticker.C:
				case <-handler.NOWOperationalJobWakeups():
				}
			}
		}()
		logger.Info().Msg("NOWPayments isolated operational membership flow configured; non-NOW finance remains read-only")
	}
	handler.SetSuperAdmins(cfg.SuperAdminEmails)
	handler.SetCartConfig(cfg.CartResumeBaseURL, cfg.SuccessURL) // recuperación de carritos abandonados
	handler.SetSupportAI(cfg.SupportAIURL, cfg.SupportAIServiceToken, cfg.SupportAIAutoDraft, cfg.SupportAIAutoReply)
	handler.SetTwilioSupportChannels(
		cfg.TwilioWebhookAuthToken,
		cfg.TwilioWebhookBaseURL,
		cfg.TwilioVerifySignature,
		cfg.VoiceAgentMaxTurns,
		cfg.VoiceSayLanguage,
		cfg.VoiceGatherLanguage,
		cfg.VoiceGatherTimeoutSec,
	)
	handler.SetPipecatVoiceAgent(cfg.VoiceAgentMode, cfg.PipecatStreamURL, cfg.PipecatStreamSecret)
	if cfg.SupportAIServiceToken != "" {
		logger.Info().
			Str("url", cfg.SupportAIURL).
			Bool("auto_draft", cfg.SupportAIAutoDraft).
			Bool("auto_reply", cfg.SupportAIAutoReply).
			Msg("support AI ticket drafts enabled")
	} else {
		logger.Info().Msg("support AI token not set; ticket AI drafts disabled")
	}
	if cfg.TwilioWebhookAuthToken != "" {
		logger.Info().
			Bool("verify_signature", cfg.TwilioVerifySignature).
			Str("base_url", cfg.TwilioWebhookBaseURL).
			Int("max_turns", cfg.VoiceAgentMaxTurns).
			Str("voice_mode", cfg.VoiceAgentMode).
			Msg("Twilio voice/WhatsApp support webhooks enabled")
	} else if cfg.TwilioVerifySignature {
		logger.Info().Msg("Twilio support webhooks mounted but disabled until PAYMENTS_TWILIO_AUTH_TOKEN is set")
	} else {
		logger.Warn().Msg("Twilio signature verification disabled; use only for local development")
	}

	// Verificación independiente de identidad (defensa en profundidad, H-2): el
	// backend re-verifica el id token Cognito que reenvía el BFF en X-VP-Id-Token,
	// en lugar de confiar en el `email` que envía el cliente. El token de servicio
	// sigue siendo requerido (segundo factor). En modo REQUIRE_VERIFIED_IDENTITY=false
	// (default) el header es opcional y hay fallback backward-compatible.
	if verifier, enabled, err := payments.ConfiguredBetterAuthVerifier(rootCtx, pool); err != nil {
		return err
	} else if enabled {
		handler.SetIdentityVerifier(verifier, true)
		logger.Info().Msg("Better Auth verified service identity and MLM subject binding enabled")
	} else if jwksURL := cfg.JWKSURL(); jwksURL != "" {
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

	// KYC: subida de documentos a S3 con URLs presignadas. Sin bucket configurado
	// los endpoints KYC responden 503 (rollout seguro).
	if cfg.ExternalProvidersEnabled() && cfg.KYCBucket != "" {
		kycS3, kerr := payments.NewKYCS3(rootCtx, cfg.KYCBucket, cfg.KYCRegion)
		if kerr != nil {
			logger.Warn().Err(kerr).Msg("KYC S3 init failed; KYC endpoints disabled")
		} else {
			handler.SetKYC(kycS3)
			logger.Info().Str("bucket", cfg.KYCBucket).Str("region", cfg.KYCRegion).Msg("KYC document upload enabled")
		}
	} else {
		logger.Info().Msg("KYC_S3_BUCKET not set; KYC endpoints disabled")
	}

	// Filtro OCR de pasaportes (OpenRouter visión). Sin API key el OCR se
	// desactiva y los pasaportes quedan in_review para revisión manual.
	if cfg.ExternalProvidersEnabled() && cfg.KYCOCRAPIKey != "" {
		ocr := payments.NewKYCOCR(cfg.KYCOCRAPIKey, cfg.KYCOCRModel)
		handler.SetKYCOCR(ocr)
		model := cfg.KYCOCRModel
		if model == "" {
			model = payments.DefaultKYCOCRModel
		}
		logger.Info().Str("model", model).Msg("KYC OCR (auto-validación de pasaporte) enabled")
	} else {
		logger.Info().Msg("KYC OCR api key not set; pasaportes quedarán en revisión manual")
	}

	// Cognito admin: deshabilitar/rehabilitar login al banear/desbanear. Sin user
	// pool configurado, el banear solo aplica el flag en la DB (sin cortar login).
	if cfg.ExternalProvidersEnabled() && cfg.CognitoUserPoolID != "" {
		region := cfg.AWSRegion
		if region == "" {
			region = "us-east-1"
		}
		if ca, cerr := payments.NewCognitoAdmin(rootCtx, cfg.CognitoUserPoolID, region); cerr != nil {
			logger.Warn().Err(cerr).Msg("Cognito admin init failed; ban no deshabilitará login")
		} else {
			handler.SetCognitoAdmin(ca)
			logger.Info().Str("pool", cfg.CognitoUserPoolID).Msg("Cognito admin (ban disable/enable) enabled")
		}
	} else {
		logger.Info().Msg("COGNITO_USER_POOL_ID not set; ban solo aplicará flag de DB")
	}

	srv := &http.Server{
		Addr:              cfg.HTTPListenAddr,
		Handler:           cfg.ReadOnlyHandler(handler.Routes()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
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
	if cfg.BackgroundJobsEnabled() {
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

		// Sweep de reconciliación: recupera pagos cuyo webhook se perdió (Stripe pagó
		// pero el intent quedó sin activar). Non-fatal — nunca debe tumbar el servicio.
		if cfg.ReconcileInterval > 0 {
			go func() {
				ticker := time.NewTicker(cfg.ReconcileInterval)
				defer ticker.Stop()
				recLog := logger.With().Str("component", "reconcile-sweep").Logger()
				recLog.Info().Dur("interval", cfg.ReconcileInterval).Dur("min_age", cfg.ReconcileMinAge).Msg("reconcile sweep started")
				for {
					select {
					case <-rootCtx.Done():
						recLog.Info().Msg("reconcile sweep stopped")
						return
					case <-ticker.C:
						res, err := handler.ReconcileStuckPayments(rootCtx, cfg.ReconcileMinAge, 500)
						if err != nil {
							recLog.Error().Err(err).Msg("reconcile sweep failed (non-fatal)")
						} else if res.Activated > 0 || res.Errors > 0 {
							recLog.Info().Int("checked", res.Checked).Int("paid_found", res.PaidFound).
								Int("activated", res.Activated).Int("errors", res.Errors).Msg("reconcile sweep complete")
						}
					}
				}
			}()
		}

		// Sweep de recuperación de carritos abandonados: recuerda por email los
		// checkouts 'created' que nunca se pagaron. cutoff = arranque del servicio ⇒
		// solo carritos NUEVOS reciben recordatorio automático (los viejos se manejan
		// manualmente desde el panel). Non-fatal.
		if cfg.CartReminderEnabled && cfg.CartReminderInterval > 0 {
			cartCutoff := time.Now().UTC()
			go func() {
				ticker := time.NewTicker(cfg.CartReminderInterval)
				defer ticker.Stop()
				cartLog := logger.With().Str("component", "cart-reminder").Logger()
				cartLog.Info().Dur("interval", cfg.CartReminderInterval).Time("cutoff", cartCutoff).Msg("cart reminder sweep started")
				for {
					select {
					case <-rootCtx.Done():
						cartLog.Info().Msg("cart reminder sweep stopped")
						return
					case <-ticker.C:
						if sent, err := handler.RemindAbandonedCarts(rootCtx, cartCutoff, 2); err != nil {
							cartLog.Error().Err(err).Msg("cart reminder sweep failed (non-fatal)")
						} else if sent > 0 {
							cartLog.Info().Int("sent", sent).Msg("cart reminders sent")
						}
					}
				}
			}()
		}

		// Sweep de respaldo del OCR de KYC: reprocesa pasaportes con ocr_status
		// 'pending' que quedaron atascados (p. ej. un reinicio a mitad del análisis).
		// El camino normal es la goroutine disparada al confirmar; esto es resiliencia.
		if cfg.KYCOCRAPIKey != "" && cfg.KYCBucket != "" {
			go func() {
				ticker := time.NewTicker(3 * time.Minute)
				defer ticker.Stop()
				for {
					select {
					case <-rootCtx.Done():
						return
					case <-ticker.C:
						handler.RunKYCOCRSweep(rootCtx)
					}
				}
			}()
		}

		// Comunicados masivos: sender (solo donde COMMS_ENABLED=true, i.e. APP) y
		// consumer de eventos SES por SQS. Non-fatal.
		if cfg.CommsEnabled {
			// Falla el arranque si la URL One-Click (RFC 8058) no se puede determinar:
			// sin ella la cabecera List-Unsubscribe-Post apuntaría a la página visible,
			// Gmail la trataría como un enlace normal y la baja en un clic dejaría de
			// funcionar en silencio, con el costo de reputación que eso implica.
			if cfg.CommsUnsubscribeOneClickURL == "" &&
				strings.Replace(cfg.CommsUnsubscribeBaseURL, "/baja", "/api/comms/unsubscribe", 1) == cfg.CommsUnsubscribeBaseURL {
				logger.Fatal().
					Str("base", cfg.CommsUnsubscribeBaseURL).
					Msg("COMMS_ENABLED=true pero no se puede derivar la URL One-Click: setear COMMS_UNSUBSCRIBE_ONECLICK_URL, o que COMMS_UNSUBSCRIBE_BASE_URL contenga /baja")
			}
			sender := payments.NewCommsSender(store, store, payments.CommsSenderConfig{
				RatePerSec: cfg.CommsSendRatePerSec, BatchSize: cfg.CommsBatchSize, SESConfigSet: cfg.CommsSESConfigSet,
				UnsubscribeSecret: []byte(cfg.CommsUnsubscribeSecret), UnsubscribeBase: cfg.CommsUnsubscribeBaseURL,
				UnsubscribeOneClickBase: cfg.CommsUnsubscribeOneClickURL,
				ReplyTo:                 cfg.CommsReplyTo,
				LegalName:               cfg.CommsLegalName,
				PostalAddress:           cfg.CommsPostalAddress,
			}, logger.With().Str("component", "comms-sender").Logger())
			handler.SetComms(sender, cfg.CommsMaxAudience, cfg.CommsMaxPerDay, cfg.CommsMaxTestSends, []byte(cfg.CommsUnsubscribeSecret))
			go sender.Loop(rootCtx)
			if cfg.CommsSQSQueueURL != "" {
				if q, err := payments.NewSQSQueueClient(rootCtx, cfg.CommsSQSQueueURL); err != nil {
					logger.Error().Err(err).Msg("comms: SQS client init failed; sin seguimiento de entregas")
				} else {
					go payments.NewCommsEventConsumer(store, q, logger.With().Str("component", "comms-events").Logger()).Loop(rootCtx)
				}
			}
		} else if cfg.CommsUnsubscribeSecret != "" {
			// Sin sender pero con secreto: el endpoint de baja sigue funcionando (WORKER/staging)
			handler.SetComms(nil, 0, 0, 0, []byte(cfg.CommsUnsubscribeSecret))
		}
	}

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
