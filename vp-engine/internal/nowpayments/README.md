# NOWPayments hosted invoices

Server-only adapter with no database, wallet, membership, payout, or Stripe side
effects. The public widget key is not used by this hosted Invoice API flow.

Required for creating invoices: `APIKey` and a separate `IPNSecret`. Missing IPN
secret deliberately blocks invoice creation and webhook validation. Presence-only
diagnostics are available through `ConfigurationStatus`; never expose `Config`.
`GetPayment` only requires the API key. Production is the default, sandbox must be
explicit. Endpoints are fixed, HTTPS, bounded, time-limited and do not redirect.

Create and persist a server-priced order before creating the invoice. Persist the
returned invoice ID. Authenticate each IPN using `VerifyIPN`; this alone does not
establish payment success. Read authoritative status with `GetPayment`, bind the
payment/order/invoice identifiers, then call `ValidateFinished`. Only `finished`
with exact USD price and sufficient crypto paid passes. Pending, confirmed,
partially paid, expired and refunded statuses never pass as successful payments.
The caller must perform an atomic, idempotent transition and uniquely constrain
the provider payment ID. Do not credit from redirect query parameters or IPN
fields supplied as the expected values.

Amounts and identifiers are kept as decimal strings/integer cents, not floats.
IPN canonicalization sorts object keys recursively, normalizes number spelling,
preserves array order, rejects duplicate keys and rejects numeric JSON that would
lose precision in the documented JavaScript signer. Large IDs/precise decimals
must be JSON strings. `OutcomeAmount` and `OutcomeCurrency` are separate optional
settlement evidence: they must not be confused with gross USD or available funds.
`ValidateFinished` is not a liquidation or balance calculation.

Official references consulted:

- https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description
- https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup
- https://nowpayments.io/payment-button

Tests use injected transports and synthetic HMAC payloads only. No provider call,
invoice creation, message, payout, or database mutation is made by the test suite.
