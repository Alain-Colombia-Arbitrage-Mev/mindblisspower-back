# Personal Reown user events

The Reown Dashboard has a native **Users → Webhook** configuration. The project
endpoint is `https://app.mindblisspower.com/api/webhooks/reown`. This belongs to
Reown user/authentication events, independently of the administrative MELD
sandbox webhook. Reown's public authentication page describes signup, login and
user-event notifications; its roadmap wording can lag the live dashboard.
The public dashboard client also implements native `/auth/v1/webhooks` CRUD and
per-endpoint secret rotation against `api.reown.com`. Those client-management
calls do not document the outgoing signature protocol and are not used by this
receiver. No authenticated dashboard API credential is copied into the app.
The dashboard's displayed event count is `success_count + failure_count`, with
missing counts treated as zero. It is not a count of selected event types.
The create request supplies only the endpoint URL; no event-type list or
incoming-signature configuration appears in that public dashboard client.

The frontend route is initially a quarantined protocol-discovery receiver.
It always returns HTTP 503 `reown_webhook_verification_pending` for inspected
deliveries. It does not acknowledge, verify, persist or apply any event, even
when `REOWN_WEBHOOK_SECRET` is configured. A dashboard endpoint registration
alone does not prove successful or authenticated delivery.

Discovery accepts only POST JSON at the exact HTTPS personal-app host/path,
with an 8 KiB byte limit and a bounded body-read deadline. Its diagnostics
contain a server timestamp, recognized header names, signature lengths/shape
categories and allowlisted JSON field names. It never logs raw payloads,
arbitrary field names, header values, email/address values, tokens, signatures
or secrets. A temporary in-memory limiter permits ten diagnostic requests per
minute per Worker isolate; it is not a durable, globally coordinated delivery
or replay store. Invalid requests and exhausted diagnostics are rejected.

Before promoting this receiver to an authenticated, acknowledged webhook:

1. Establish the authoritative Reown wire contract: signature header names,
   algorithm, secret decoding, exact signed bytes, timestamp/message-ID format,
   replay tolerance and key-rotation rules. Do not infer these from another
   provider or from a signature prefix alone.
2. Store the one-time endpoint secret as the private Cloudflare secret
   `REOWN_WEBHOOK_SECRET`; never expose it through `NEXT_PUBLIC_*`, logs, source
   control or chat. The public Reown project ID is not a signing secret.
3. Verify a genuine signed test delivery against that contract and confirm the
   expected project and allowed event types. Reject forged, stale, mismatched
   and replayed deliveries with constant-time signature comparison where
   applicable. Authenticate exact raw bytes before parsing an actionable event.
4. Add a durable, idempotent audit/inbox capability with bounded fields and
   event-ID/body-digest conflict handling before acknowledging processing.
   This is separate work and does not modify the frozen payment migration 100.

`useAppKitEvents` is a different mechanism: browser-side SDK events can drive
UI refresh or telemetry, but are client assertions rather than signed server
notifications. No authenticated SDK telemetry endpoint is substituted for the
native Reown webhook.

User events never establish a Mindbliss login, prove wallet ownership, confirm
an onramp payment, credit a wallet, assign a membership or calculate commission.
Better Auth still grants the application session; the existing signed wallet
binding and independent chain/receipt checks retain their own authority.

The administrative `https://wallet.mindblisspower.com/api/webhooks/meld`
receptor uses a different account/profile/signature secret and is disabled by
the current Core webhook flag. Neither its credentials nor its payload contract
are reused for Reown. No Reown native signature scheme has been assumed from
MELD's documented HMAC protocol.

Primary references:

- [Reown Authentication](https://docs.reown.com/cloud/reown-authentication)
- [Reown AppKit event hook](https://docs.reown.com/appkit/react/core/hooks#useappkitevents)
- [Reown SIWX implementation](https://docs.reown.com/appkit/authentication/siwx/reown-authentication)
- [MELD webhook authentication, for distinction only](https://docs.meld.io/docs/stablecoins/for-all-products/webhooks-authentication)
