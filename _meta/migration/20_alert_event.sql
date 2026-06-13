-- alert_event — Centro de Mando alerts (Sub-proyecto 2).
-- Owned by vp-api. Apply: psql -U migrator -d vicionpower -f 20_alert_event.sql
-- Pre-req: schema_mlm.sql (needs mlm schema + mlm.person).
SET search_path = mlm, public;

CREATE TABLE IF NOT EXISTS mlm.alert_event (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal          text   NOT NULL,   -- 'theta'|'outflows_vs_fund'|'rank_avalanche'|'leg_skew'
  severity        text   NOT NULL CHECK (severity IN ('info','warning','critical')),
  metric_value    numeric(20,4),
  threshold       numeric(20,4),
  detail          text   NOT NULL,
  payload         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  status          text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by bigint REFERENCES mlm.person(id),
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- At most one OPEN alert per signal (dedupe target for upsert-on-evaluation).
CREATE UNIQUE INDEX IF NOT EXISTS alert_event_open_signal_idx
  ON mlm.alert_event(signal) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS alert_event_status_idx ON mlm.alert_event(status, created_at DESC);
