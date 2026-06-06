# 0014 — Wallet crypto via API externa (no self-custody)

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita manejar wallets crypto (USDT-TRC20, BTC, posiblemente otros) para:

1. Recibir depósitos de afiliados que compran paquetes con crypto.
2. Procesar retiros de comisiones a wallets externos de afiliados.
3. Mantener saldos internos por afiliado (`mlm.wallet`) sincronizados.

El equipo **ya tiene una integración con un proveedor de wallet vía API** que maneja:
- Generación de direcciones de depósito por afiliado.
- Confirmación de depósitos en blockchain (con N-confirmations apropiadas).
- Ejecución de retiros a direcciones externas.
- Custody de las claves privadas.

Esta ADR formaliza la decisión de **NO construir wallet propio** (HD wallet con bitcoinjs-lib + tronweb + watcher) sino integrar con la API existente.

## Decision

**Integración con wallet API externa como única fuente de verdad de blockchain state.**

Patrón:
- **Custody de keys:** completamente del proveedor. Nosotros nunca tocamos private keys.
- **Direcciones:** el proveedor genera; nosotros guardamos `mlm.wallet.address` referenciando la dirección externa.
- **Saldos:** dual model:
  - `mlm.wallet.balance` es el saldo **interno** (lo que el afiliado puede operar dentro de VicionPower; afectado por bonos, comisiones, retiros).
  - El saldo en la wallet externa es el saldo **on-chain** (lo que existe en blockchain bajo custody del proveedor).
  - Estos dos pueden diferir transitoriamente (depósito recién llegó pero aún no procesado; retiro ya descontado internamente pero aún no broadcast).
- **Reconciliación nightly:** job que compara `mlm.wallet.balance` vs `provider.GetBalance(address)`. Drift > tolerancia → alerta P0 (similar a `v_wallet_balance_truth`).

### Architecture

```
                    Afiliado deposita en address X
                              │
                              ▼
                  ┌───────────────────────┐
                  │ Wallet API Provider   │  ← custody, blockchain ops
                  │ (BitGo / Fireblocks / │
                  │  Tatum / equivalent)  │
                  └────────┬──────────────┘
                           │ webhook firmado
                           ▼
                  ┌────────────────┐
                  │ vp-api (TS)    │  webhook handler
                  │ - valida firma │
                  │ - dedup        │
                  │ - publica NATS │
                  └────────┬───────┘
                           │ NATS: payments.deposit_confirmed
                           ▼
                  ┌────────────────┐
                  │ vp-engine (Go) │  consume event
                  │ - postTransaction │ → mlm.transaction (idempotent)
                  │ - activate package│
                  └────────────────┘
```

Para retiros (outbound):

```
afiliado solicita retiro → vp-api workflow approval → vp-engine.WithdrawalExecutor
                                                            │
                                                            ▼
                                               Wallet API .CreateWithdrawal()
                                                            │
                                                            ▼ (async, on-chain)
                                                  webhook withdrawal.completed
                                                            │
                                                            ▼
                                                vp-engine actualiza
                                                withdrawal_request.status = 'paid'
                                                + mlm.transaction confirmada
```

### Eliminado de la arquitectura previa

Lo siguiente, definido en BACKEND_PLAN §3.7 y bosquejado en `vp-engine/internal/chainwatcher/`, **se elimina**:

- HD wallet self-custody (no `btcsuite/btcd`, no `gotron-sdk`).
- Watcher de blockchain conectado directamente a TRC20/BTC nodes.
- Manejo de seed phrases, key rotation, hot/cold separation.
- Compliance burden de custody (Travel Rule, BitLicense, etc. recae en el proveedor).

El módulo `chainwatcher/` en `vp-engine` se redefine como **`walletbridge/`**: un componente que consume webhooks del wallet provider (vía vp-api) y traduce a operaciones contables internas.

## Consequences

### Positivas

- **Sin custody = sin compliance crypto pesado.** Travel Rule, AML para custodians, segregación de fondos cliente, bonding/insurance — todo eso es responsabilidad del proveedor. Nosotros somos "operator no-custodial".
- **Sin manejo de keys.** Riesgo más grande de fintech crypto (key compromise = pérdida total de fondos) está completamente delegado.
- **Sin nodos de blockchain a operar.** Sin sync de TRC20 nodes, sin BTC full nodes consumiendo cientos de GB.
- **Speed-to-market.** Integración por API es 1-2 semanas vs. 2-3 meses para self-custody seguro.
- **Equipo Go senior libre** para el motor de bonos en lugar de gastar 6-8 semanas en chainwatcher infra.
- **Provider auditado.** Si elegimos un provider con SOC 2 / ISO 27001 / SOC for Service Organizations, su auditoría apoya nuestra postura de compliance.
- **Costo de cómputo bajo.** No necesitamos VM dedicada para nodes, no banda ancha alta para chain sync.

### Negativas

- **Dependencia operacional crítica.** Si el provider tiene downtime, nosotros tenemos downtime de crypto (deposits y withdrawals). Mitigación: SLA contractual + status page monitoring; documentar workaround manual para emergencias.
- **Costo por transacción.** Providers cobran 0.1-0.5% por deposit/withdrawal o fee fijo. Sumado a fees de blockchain. Para volumen alto puede ser >$1k/mes.
- **Vendor lock-in.** Migrar de un provider a otro requiere migrar direcciones (re-generar) y posiblemente fondos. Costo significativo. Mitigación: contractar provider serio con history de operación; documentar Plan B (segundo provider).
- **Limited control over UX.** Tiempos de confirmación, fee policies, blockchain selection son del provider. Si decidimos soportar nueva chain (Polygon, Arbitrum), depende del provider.
- **Reconciliación obligatoria.** Aunque el provider es source-of-truth on-chain, debemos comparar con nuestro `mlm.wallet.balance` interno nightly. Drift indica bug en nuestro lado o issue del provider.
- **Withdrawal approval flow** (ADR 0010) ahora es más complejo: 2 admins firman → vp-engine llama API provider → provider procesa async → webhook confirma. Más asíncrono que self-custody donde controlamos el broadcast.

### Neutras

- Provider TBD. Decisión de provider específico no es ADR aún (depende de pricing real, KYB con cada uno, geographic coverage). Esta ADR es agnóstica al provider — el patrón funciona con cualquiera.
- Si el provider quiebra, los fondos de afiliados están afectados, pero existen vías legales y los providers serios tienen segregación de fondos cliente (no cuentas comunes).

## Provider candidates

A evaluar y elegir en próxima ADR cuando equipo procurement valide pricing y KYB:

| Provider | Strengths | Costo aprox | Notas |
|---|---|---|---|
| **BitGo** | Líder enterprise, SOC 2 Type II, $1.5B AUM, $250M insurance | $1k-3k/mo + 0.1% | KYB estricto, mejor para institucional |
| **Fireblocks** | Mejor DX para devs, MPC technology, multi-chain robusto | $2k-5k/mo + fees | Líder mercado tech, popular en MLM/exchanges |
| **Tatum** | API más simple, multi-chain wide, pricing accesible | $0.05-0.15 por tx | Best-in-class developer experience |
| **Anchorage** | Federal banking charter US, máxima compliance | Enterprise pricing | Si necesitamos US institutional support |
| **Coinbase Custody / Cloud** | Brand recognition, USA presence | Custom pricing | Mejor para B2C-USA |
| **Circle Mint / USDC native** | Solo USDC, settlement instantáneo | % por tx | Si nos enfocamos en stablecoin USD |

**Recomendación inicial para evaluar:** Tatum (DX excelente + costo accesible) o Fireblocks (más maduro pero más caro). Decisión final depende de lo que el equipo ya tiene integrado.

### Si el equipo "ya tiene" se refiere a un wallet propio interno (no third-party)

Si "wallet por API" significa un servicio interno construido previamente (no un third-party como BitGo):
- Esta ADR sigue aplicando — el patrón es el mismo (otra API, otra fuente de verdad).
- Pero compliance burden NO queda delegado — sigue siendo nuestro.
- En ese caso, considerar migrar a un provider third-party real para v2 si el negocio crece significativamente.

## Alternatives considered

### Self-custody con HD wallets propias (planeación previa)

**Rechazado.**
- 2-3 meses de desarrollo seguro vs 1-2 semanas de integración API.
- Compliance burden completo (Travel Rule, sanctions screening, AML monitoring).
- Riesgo operacional altísimo: una clave perdida o comprometida = pérdida total.
- Hot/cold wallet operations require dedicated SRE.
- Insurance very difficult to obtain, very expensive.

Razonable solo para players con $100M+ AUM y equipo de 5+ específicamente en custody.

### Multi-provider (BitGo primary + Fireblocks secondary)

**Rechazado para v1, considerado para v3.**
- Redundancia mejora resiliencia.
- Complejidad de routing y reconciliación dual.
- Costo dobla.
- Implementar después de >$10M/mes volumen.

### Solo crypto via Stripe Crypto Onramp

**Rechazado.**
- Stripe Crypto solo cubre fiat→crypto onramp para clientes (compras), no custody ni withdrawals.
- No es wallet provider; es card-to-crypto bridge.
- Útil como complemento (Stripe procesa card → afiliado recibe crypto en wallet provider) pero no reemplaza la decisión.

### Solo stablecoin (USDC vía Circle Mint)

**Considerado parcialmente.**
- Si todo el negocio opera en USDC, Circle Mint da settlement instantáneo y compliance favorable.
- Pero afiliados usan BTC y otras chains; restricción a USDC limita flexibility.
- Plan B: transicionar gradualmente a USDC-mayoritario si volumen lo soporta.

## Implementación

### En `vp-api` (TS)

```
src/modules/payments/wallet/
├── webhook.ts          # POST /api/webhooks/wallet (firma del provider)
├── client.ts           # cliente HTTP del provider (BitGo SDK / Tatum SDK / etc.)
├── service.ts          # CreateWithdrawal, GetAddress, GetBalance
└── reconciliation.ts   # nightly job
```

### En `vp-engine` (Go)

`internal/chainwatcher/` se renombra a `internal/walletbridge/`:

```
internal/walletbridge/
├── bridge.go           # consume NATS payments.deposit_confirmed
├── deposit.go          # crea mlm.transaction inbound (concept=deposit)
└── withdrawal.go       # ejecuta retiro: llama provider via gRPC desde vp-api
```

(NOTA: el actual `chainwatcher/watcher.go` quedará marcado como deprecated y migrado al nuevo módulo cuando el equipo Go arranque la implementación.)

### Reconciliación nightly

`scripts/reconcile-wallets.sh` (similar a `check-drift.sh`):
1. Para cada `mlm.wallet`, llamar `provider.GetBalance(address)`.
2. Comparar con `mlm.wallet.balance`.
3. Reportar drift si > $0.001 USD o > 0.00000001 BTC.
4. Slack alert si cualquier wallet drifteó.

## References

- ADR 0001 — `mlm.wallet` interno como source of truth contable.
- ADR 0002 — `vp-api` maneja webhooks; `vp-engine` ejecuta integraciones outbound.
- ADR 0007 — NATS para events `payments.deposit_confirmed`.
- ADR 0010 — withdrawals con cuatro-ojos.
- ADR 0013 — Stripe complementario para card payments.
- BACKEND_PLAN §3.7 (`payments` module — actualizado).
- Travel Rule (FATF Recommendation 16): https://www.fatf-gafi.org/en/recommendations/
- BitGo: https://www.bitgo.com/
- Fireblocks: https://www.fireblocks.com/
- Tatum: https://tatum.io/
