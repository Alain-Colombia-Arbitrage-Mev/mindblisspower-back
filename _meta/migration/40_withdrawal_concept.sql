-- =============================================================================
-- 40_withdrawal_concept.sql — concepto de DÉBITO de retiro (auditoría C1)
-- =============================================================================
-- Cierra la brecha de doble-gasto C1: al marcar un retiro 'paid', el panel admin
-- (payments.SetWithdrawalStatus) ahora postea un débito contable en la misma
-- transacción. Ese asiento necesita un concepto dedicado.
--
--   id      = 1013  (rango 1000+ de conceptos nuevos; sigue a 1012)
--   kind    = 'withdrawal'  (ya existe en el enum mlm.concept_kind)
--   factor  = -1            (débito: mlm.fn_validate_movement exige amount < 0)
--   requires_pair = false   (retiro de una sola vía: el dinero SALE del sistema
--                            hacia el banco/crypto; no hay contra-crédito interno,
--                            igual que 1007/1009. Con requires_pair=false el
--                            trigger de balanceo NO exige contraparte).
--   active  = true
--
-- Idempotente (ON CONFLICT). Reflejado también en _meta/schema_payouts_v1.3.sql
-- para que las DB de test/fresh lo traigan del schema base.
-- =============================================================================

INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
  (1013, 'withdrawal', 'Retiro pagado (débito)', 'Withdrawal paid (debit)', -1, false, true)
ON CONFLICT (id) DO NOTHING;
