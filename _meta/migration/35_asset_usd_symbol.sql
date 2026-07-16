-- 35_asset_usd_symbol.sql — el código (activation.go, cd_roi.go ensureUSDWallet) resuelve
-- el asset dólar por symbol='USD', pero la migración puso asset.symbol = name legacy y el
-- dólar quedó como 'DLS' (Dólares). Sin esto, la activación abre el CD pero NO postea el
-- inflow (1004) ni acredita ROI (1006). Confirmado por el dueño 2026-07-06: DLS = USD.
-- Aplicado a RDS 2026-07-06. Idempotente.
UPDATE mlm.asset SET symbol='USD' WHERE symbol='DLS';
