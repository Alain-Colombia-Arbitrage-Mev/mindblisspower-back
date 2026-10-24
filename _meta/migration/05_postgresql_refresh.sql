-- Explicit reporting maintenance only. Does not run payouts or delete history.
-- Use a DIRECT connection (not transaction pooling), as the view owner/app_admin.
-- First refresh must be non-concurrent; later refreshes keep readers available.
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '15min';
SELECT pg_try_advisory_lock(572619024) AS reporting_lock \gset
\if :reporting_lock
SELECT format('REFRESH MATERIALIZED VIEW %s %s;',
              CASE WHEN c.relispopulated THEN 'CONCURRENTLY' ELSE '' END,
              c.oid::regclass)
FROM pg_class c
WHERE c.oid IN ('mlm.mv_earnings_monthly'::regclass,
                'mlm.mv_network_growth_daily'::regclass,
                'mlm.mv_ledger_volume_daily'::regclass)
ORDER BY c.relname
\gexec
SELECT pg_advisory_unlock(572619024);
\else
\echo 'Another reporting refresh is active; skipped.'
\endif
