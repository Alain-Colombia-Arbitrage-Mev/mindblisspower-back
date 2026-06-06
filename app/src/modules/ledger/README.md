# ledger

Wallets, transacciones, movimientos. **Único módulo que escribe `wallet_movement` y `transaction`.**

**Estado:** `postTransaction` y `registerPvCredit` implementados en `src/server/affiliate.ts`. Falta mover aquí + agregar queries de lectura.

**Tablas owned:** `mlm.wallet`, `mlm.transaction`, `mlm.wallet_movement`.

**API interna:**
- `getWallet(affiliateId, assetId)` — balance + último movimiento.
- `postTransaction({externalRef, description, movements[]})` — atómica, idempotente, valida pareo (existente).
- `reverseTransaction(originalTxnId, reason)` — crea nueva transacción que netea.
- `getMovements(walletId, {from, to, cursor, limit})` — cursor pagination por `posted_at, id`.

**Endpoints:**
- `GET /api/me/wallets`
- `GET /api/me/movements?asset=USD&from=2026-01-01&cursor=...`
- `GET /api/me/movements/:movementId`

**Eventos:**
- Emite: `ledger.transaction_posted`, `ledger.movement_recorded`.
- Escucha: `payouts.bonus_run_completed` → batch `postTransaction`.

**Invariantes:**
- Toda mutación va por `postTransaction`. Exige `external_ref` único.
- Conceptos `requires_pair=true` deben netear a 0 al pasar status='posted' (trigger valida).
- `wallet.balance` se actualiza por trigger; `check-drift.sh` valida coherencia nocturna.

**Pendientes:**
- [ ] Mover `postTransaction` y `registerPvCredit` desde `server/affiliate.ts`.
- [ ] Cursor-based pagination en `getMovements` con índice compuesto.
- [ ] Helper para queries paralelas (e.g. snapshot multi-wallet).
- [ ] Test de propiedad: para N transacciones aleatorias, `sum(movements.amount) per wallet = wallet.balance`.
