-- Ledger queries — vp-engine.ledger module.
-- sqlc genera funciones tipadas desde aquí. Schema source: _meta/schema_mlm.sql.

-- name: UpsertTransaction :one
-- Idempotente por external_ref. Si el ref ya existe, no crea nueva.
INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
VALUES (@external_ref, @description, 'pending', @initiated_by_person_id)
ON CONFLICT (external_ref) DO UPDATE SET description = EXCLUDED.description
RETURNING id;

-- name: PostTransaction :exec
-- Marca como 'posted' (dispara fn_validate_transaction).
UPDATE mlm.transaction
   SET status = 'posted', posted_at = now()
 WHERE id = @id AND status = 'pending';

-- name: InsertWalletMovement :exec
-- Inserta un movement individual. Trigger fn_validate_movement enforce
-- que el sign del amount coincide con concept.factor.
INSERT INTO mlm.wallet_movement (
  transaction_id, wallet_id, affiliate_id, concept_id,
  amount, reference, posted_at, available_at
) VALUES (
  @transaction_id, @wallet_id, @affiliate_id, @concept_id,
  @amount, @reference, @posted_at, @available_at
);

-- name: GetWalletByAffiliateAndAsset :one
SELECT id, affiliate_id, asset_id, address, balance
  FROM mlm.wallet
 WHERE affiliate_id = @affiliate_id AND asset_id = @asset_id;

-- name: GetMovementsForWallet :many
-- Cursor pagination by (posted_at, id).
SELECT wm.id, wm.transaction_id, wm.concept_id, wm.amount, wm.reference, wm.posted_at
  FROM mlm.wallet_movement wm
 WHERE wm.wallet_id = @wallet_id
   AND (wm.posted_at, wm.id) < (@cursor_posted_at, @cursor_id)
 ORDER BY wm.posted_at DESC, wm.id DESC
 LIMIT @max_rows;

-- name: GetTransactionByExternalRef :one
SELECT id, external_ref, status, posted_at, description
  FROM mlm.transaction
 WHERE external_ref = @external_ref;
