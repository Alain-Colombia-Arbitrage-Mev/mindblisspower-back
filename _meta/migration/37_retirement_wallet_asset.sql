-- 37_retirement_wallet_asset.sql — Prepara el schema para el wallet dedicado de jubilación
-- (401k C1 fix). El motor (retirement.go) ahora acredita el aporte (concepto 1007) en un
-- wallet separado con asset 'USD-RET' en vez de debitar el wallet USD del afiliado.
-- Dos cambios:
--   1. Inserta asset 'USD-RET' (Retirement USD), espejo de USD: is_fiat=true, decimals=2.
--   2. Voltea el factor del concepto 1007 de -1 a +1: la contribución es ahora un CRÉDITO
--      al wallet de retiro, no un débito al wallet USD.
-- Idempotente: el INSERT usa NOT EXISTS y el UPDATE es seguro re-corrido.

BEGIN;

-- §1. Asset dedicado de jubilación -----------------------------------------------
-- Espeja is_fiat=true y decimals=2 del asset 'USD' (id=2, confirmado en dev DB).
-- El id se calcula como MAX(id)+1 para evitar colisiones (no hardcodeado).
INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals, current_value_usd)
SELECT (SELECT COALESCE(MAX(id), 0) + 1 FROM mlm.asset),
       'USD-RET',
       'Retirement USD',
       true,   -- is_fiat: espeja USD
       2,      -- decimals: espeja USD
       1       -- current_value_usd: paridad 1:1 con USD
 WHERE NOT EXISTS (SELECT 1 FROM mlm.asset WHERE symbol = 'USD-RET');

-- §2. Flip factor concepto 1007 de -1 → +1 ---------------------------------------
-- Antes: el aporte se posteaba como DÉBITO al wallet USD (amount negativo × factor -1).
-- Ahora: el aporte se postea como CRÉDITO al wallet USD-RET (amount positivo × factor +1).
-- La función fn_rebuild_monthly_settlement usa SUM(amount * factor); el resultado
-- económico (to_retirement_usd) sigue siendo positivo en ambos casos — sólo cambia
-- el wallet destino y la dirección contable. Ver ADR-0018 y migration 36.
UPDATE mlm.concept
   SET factor = 1
 WHERE id = 1007;

COMMIT;

\echo '=== 37_retirement_wallet_asset.sql aplicado ==='
