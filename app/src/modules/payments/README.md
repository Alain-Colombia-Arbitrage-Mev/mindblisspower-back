# payments (entrada de dinero)

Recibir dinero (compras de paquete, depósitos).

**Sub-módulos:**
- `crypto/` — USDT-TRC20 + BTC. HD wallet con derivación por afiliado.
- `bank/` — transferencia bancaria con comprobante; manual review.
- `card/` — Mercado Pago Colombia (PSE habilitado).

**Patrón común:**
1. Cliente pide iniciar pago → recibe `payment_intent_id` + instrucciones.
2. Pago llega (webhook proveedor o watcher de blockchain).
3. Sistema valida monto + ref, crea `mlm.transaction` con `external_ref='payment:<provider>:<id>'`.
4. Emite `payments.confirmed` que `packages` o `withdrawals` consume.

**Pendientes (fase 3):**
- [ ] Decidir provider de card payments (BACKEND_PLAN §13).
- [ ] HD wallet design para crypto.
- [ ] Webhook signature verification por proveedor.
- [ ] Blockchain watcher (USDT-TRC20: 20 confirmaciones).
- [ ] Anti-fraude: límites por afiliado/día.

**Nota crítica:** todos los webhooks deben ser idempotentes y verificar firma.
