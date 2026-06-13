-- ============================================================================
-- 30_payments.sql — Esquema de pagos (Stripe) para cmd/vp-payments.
--
-- Decouple-by-design: el servicio de pagos solo escribe en el esquema
-- `payments`. La activación contable (mlm.transaction / wallet_movement) y la
-- colocación en árbol las hace vp-engine (walletbridge) al consumir el evento
-- NATS `payments.deposit_confirmed`. REGLA DE ORO (ADR-0008 §4): nadie fuera
-- del motor Go escribe el ledger.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS payments;

-- Intento de compra: una fila por sesión de Checkout creada.
CREATE TABLE IF NOT EXISTS payments.purchase_intent (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Identidad (Cognito → mlm.person). No FK: el esquema payments es desacoplado.
  user_id               text        NOT NULL,
  person_id             bigint      NOT NULL,
  affiliate_id          bigint,             -- null si aún no está colocado en el árbol
  sponsor_affiliate_id  bigint,             -- usado por walletbridge para auto-colocar

  -- Paquete + precio (snapshot al momento de crear el intent).
  package_id            integer     NOT NULL,
  pv                    integer     NOT NULL,
  amount_usd            numeric(14,2) NOT NULL,   -- valor del pack
  fee_usd               numeric(14,2) NOT NULL,   -- 1% manejo/activación
  total_cents           bigint      NOT NULL,     -- (amount+fee) en centavos, lo que cobra Stripe
  currency              text        NOT NULL DEFAULT 'usd',

  -- Estado + referencias Stripe.
  status                text        NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created','paid','activated','needs_placement','failed','expired','refunded')),
  stripe_session_id        text UNIQUE,
  stripe_payment_intent_id text,
  paid_at               timestamptz,
  activated_at          timestamptz
);

CREATE INDEX IF NOT EXISTS purchase_intent_user_idx   ON payments.purchase_intent (user_id);
CREATE INDEX IF NOT EXISTS purchase_intent_status_idx ON payments.purchase_intent (status);
CREATE INDEX IF NOT EXISTS purchase_intent_pi_idx     ON payments.purchase_intent (stripe_payment_intent_id);

-- Deduplicación de eventos de webhook (idempotencia a nivel de evento Stripe).
CREATE TABLE IF NOT EXISTS payments.stripe_event (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
