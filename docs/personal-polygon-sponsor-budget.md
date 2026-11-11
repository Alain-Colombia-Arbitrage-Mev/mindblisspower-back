# Polygon sponsorship accounting

Migration `107_personal_polygon_actual_gas_budget.sql` corrects the internal
daily gas allowance. Previously, every completed attempt consumed its maximum
reservation rather than its verified gas cost. With the current defaults,
two completed attempts could exhaust a user's allowance even when their
combined network cost was much lower.

The budget helper now uses the positive `actual_gas_cost_wei` from the immutable
canonical outcome for each exact attempt, after at least twelve confirmations.
An authorization can have a reverted attempt and a successful retry, so the
current payment row is not used as a substitute for the per-attempt gas ledger.

Pending reservations, ambiguous sends, and spent reservations without a usable
positive canonical outcome continue to consume their complete maximum. Expired
unsigned drafts retain their existing exclusion. Nothing cancels or releases an
accepted authorization merely because time passed or the UI was closed.

The existing configuration remains:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERSONAL_POLYGON_RELAY_MAX_FEE_WEI` | `1000000000000000000` | Maximum reservation per attempt, 1 POL |
| `PERSONAL_POLYGON_RELAY_OWNER_DAILY_BUDGET_WEI` | `2000000000000000000` | Per-user daily allowance, 2 POL |
| `PERSONAL_POLYGON_RELAY_DAILY_BUDGET_WEI` | `10000000000000000000` | Global daily allowance, 10 POL |

Amounts use POL wei and the spent window uses UTC. These are internal safety
allowances, separate from the sponsor's Pimlico account balance. This correction
does not increase them or disable Pimlico's own policies.

The migration replaces one private SQL helper and preserves its OID, owner and
ACL. It holds the existing global budget advisory lock, checks the previous
function fingerprints, and leaves payment rows, receipts, signatures, bindings,
other wallets and financial ledgers unchanged. Existing confirmed receipts are
accounted correctly immediately, without rewriting history or resending funds.

Run the isolated SQL regression suite with:

```text
node scripts/test-polygon-relay-schema.mjs --sponsor-budget
```

The suite first runs the frozen Polygon baseline and ownership/amount probes,
then applies migration 107 in a disposable PostgreSQL container with networking
disabled. It covers the two-payment exhaustion regression, separate reverted
and successful attempts, conservative fallback for missing/zero/malformed gas
proof, immutable history, unchanged function ACLs, and concurrent global budget
checks. It never calls a provider, signs a transaction or moves funds.
