# Payments API boundaries

Keep transport, authorization, provider callbacks and financial evidence separate.
The service deliberately uses a single Go package so refactors do not introduce
extra network calls or change its public routes.

| Module | Responsibility |
| --- | --- |
| `http.go` | Handler dependencies and remaining member/admin queries |
| `http_routes.go` | Public route inventory; no business rules |
| `http_identity.go` | Service authentication, verified identity, roles and read-only impersonation |
| `http_checkout.go` | Checkout validation and placement orchestration |
| `http_webhook.go` | Verified Stripe callbacks and existing idempotent activation flow |
| `http_plan.go` | Administrative plan proposal/approval transport |
| `member.go` | Operational member payments and wallet reads |
| `member_recovery.go` | Read-only member evidence from the curated Stripe source |
| `stripe_recovery_read.go` | Read-only administrative recovery reports |
| `tree_read_cache.go` | Bounded, display-only tree cache; never an authorization source |

## Member recovery contract

When canonical recovery evidence exists, `/api/payments/me` returns:

- `data_source: "verified_stripe_recovery"`;
- `financial_status: "pending_calculation_and_review"` and `payout_locked: true`;
- explicit `null` for wallet balance, available/maturing commissions and
  available withdrawal funds, because no affiliate liability was calculated;
- `payments: []` and a separate `stripe_sales` array containing only successful,
  live, product-tagged Stripe captures linked to the verified member's person ID;
- actual existing tree position, rank and active-package count. Captures never
  fabricate a membership activation, historical placement or commission award.

Company settlement totals and company reserves are not individual balances.
Refunds, disputes and source eligibility remain visible in the evidence array.
Unverified person mappings and other products on the shared Stripe account are
excluded. Operational databases without recovery evidence retain the existing
string-valued balance contract.

Recovery reads bypass the operational balance cache and use the primary database.
The HTTP member response is private and non-cacheable. Server-side display caches
do not replace identity verification or suspension checks.

## Verification

```sh
go test ./... -run '^$'
go vet ./...
go test ./internal/payments -count=1 -timeout=15m
```

Integration tests create isolated PostgreSQL containers. Never point tests at a
production database. Run race tests with a CGO-capable Go toolchain before release.
The route-authorization regression discovers routes across all production Go
files, so extracting a handler cannot silently remove it from the security test.

## Recovery financial write lock

`internal/shared/financialguard.RequireOperational` rejects financial mutations
whenever canonical recovery evidence exists. A failed mode check also blocks the
operation. This guard is enforced by the domains, not just by the UI or job flags:
ledger posting, purchase creation/resumption/activation, refunds, operational
charges, withdrawal requests/status transitions, binary settlement, ROI and
compensation points all check it before financial side effects. HTTP endpoints
return `503` and ledger posting returns gRPC `FailedPrecondition` for recovery.

A populated plan does not automatically unlock the recovered database. Releasing
funds requires a separately reviewed operational transition. Profile, identity,
support and read-only evidence queries are not authorized to create commissions.

## Optional Better Auth identity

Cognito remains the default, including its existing claim policy. To opt in to
Better Auth, configure `AUTH_PROVIDER=better-auth`, `BETTER_AUTH_JWKS_URL`,
`BETTER_AUTH_JWT_ISSUER` and `BETTER_AUTH_JWT_AUDIENCE` explicitly. All three Go
services then require a verified service JWT on the existing identity header.
They accept RS256 only, a subject, verified email/authentication booleans and a
maximum five-minute lifetime. They never accept a Better Auth session cookie as
a service JWT, share an HMAC secret, or fall back to Cognito after token failure.

The verified subject must have an explicit `identity.auth_binding` to a business
person. Matching email alone never claims a migrated identity. Missing bindings
or conflicting canonical email require review. Deploy the prepared identity
migration and least-privilege grants before enabling this provider; startup does
not run migrations or change the default provider.

Future Stripe checkouts use a server-derived public person UUID for
`client_reference_id`. Session and PaymentIntent receive the same small identifier
allowlist from the persisted purchase owner. They do not receive contact details,
balances or network snapshots. Sponsor eligibility is rechecked without changing
the saved placement policy. Existing Stripe customers and historical metadata are
not modified, and the recovery financial write lock remains in force.
