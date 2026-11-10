# Read-only evidence and isolated HTTP egress canary

Status: **not approved for production activation**. Both checked-in environments
keep `CORE_HTTP_EGRESS_STRICT_ENABLED=false`. This runbook creates no resource,
sends no email/OTP, reads no customer record and changes no production setting.
The new constructor guard explicitly rejects strict activation before installing
any SDK handler because a public rollback is not verified in SDK 0.3.7. Unknown
flag values fail closed, rather than reverting to unrestricted internet access.

## Evidence already available without customer/provider actions

- Exact per-service HTTP allow/deny contracts pass the local fixture suite.
- The actual API runtime, Bun 1.4.4, passes an offline TLS acceptance fixture:
  a private synthetic CA is rejected when absent, accepted through
  `NODE_EXTRA_CA_CERTS`, and still rejects a mismatched hostname. Raw TLS to a
  local non-HTTP client is also verified. Docker uses `--network none`; no
  provider or database endpoint is contacted.
- API configuration adds the SDK's CA path only when observation or strict HTTP
  interception is enabled. Existing Go consumers keep their system and injected
  CA roots. All PostgreSQL DSNs still require `sslmode=verify-full`.
- HTTP interception is not a raw TCP firewall. `enableInternet` remains true in
  the production application; do not disable it to test an HTTP allowlist.

Run the opt-in local check from this directory:

```sh
node test/http-egress-tls.synthetic.mjs --local-only
```

It requires the already-built `mindbliss/api-security-release-20261104` image,
Docker and OpenSSL (Git for Windows paths are detected). Temporary certificates
and keys are generated only for that execution and removed afterward. A failure
is unknown/unavailable evidence, never permission to weaken TLS validation.

This verifies Bun's CA handling, **not** Cloudflare's actual CA file injection,
SDK routing, production certificate permissions or completeness of runtime
destinations. A healthy existing public login page does not prove those either.

## Rollback limitation in the installed SDK

`@cloudflare/containers` 0.3.7 persists both `outboundHandlerOverride` and
`hasInterceptAllRegistration` in Durable Object storage. Its constructor restores
them. It exposes no public method to remove the catch-all handler/interception.
`removeOutboundByHost` removes only per-host overrides; `setOutboundHandler(null)`
or `undefined` is not a supported reset. Disabled mode deliberately does not
alter existing SDK state or replace another handler with a passthrough handler.
**Changing the flag back to false and restarting a Container is not a proven
rollback.** The API could retain HTTPS interception while the next process no
longer receives the additional CA setting, breaking outgoing TLS/OTP delivery.

Do not edit/delete SDK-private storage keys, the production singleton, auth
sessions, JWKS or database rows to undo a canary. Do not solve this by disabling
certificate verification. The current production policy was never activated;
this is an activation/rollback prerequisite, not evidence of today's OTP cause.

## Proposed reversible canary — requires separate review before deployment

1. Use a **new isolated Worker, DO namespace and instance**, never any production
   singleton. No public route, `workers.dev`, Cron, database binding/DSN, real
   provider key, native auth session, email recipient or financial capability.
   Use the pinned Bun runtime but start only a bounded synthetic test harness,
   not the application server. Keep canary `enableInternet=false`.
2. Configure SDK HTTPS interception and the same additional-CA path there. Use
   synthetic credentials and a fixed fake acknowledgement handler. A native Bun
   HTTPS POST to the exact selected sender path contains only a synthetic marker,
   no recipient or OTP. Intercept it with `containerHttpOutbound` and inject a
   **local response function**, never `fetch`, as its internet transport. This
   exercises the Container-to-SDK CA and allowlist without contacting Resend or
   Cloudflare Email. If interception fails, disabled canary internet must block
   the request rather than reaching a provider.
3. Deny unselected providers, unknown hosts, HTTP downgrade, alternate paths,
   credentials, query strings and redirects. Verify the fixed private routing
   policy with synthetic responses; never query existing payments or start jobs.
   Log only test name, booleans and bounded status enums. Never export CA private
   keys, DSNs, requests, recipient data or headers.
4. Test the flag-off/restart transition **inside that disposable canary** and
   observe SDK persistence/TLS behavior. Retiring only the isolated canary has no
   customer/session state; do not treat production DO deletion as equivalent.
5. Before production, resolve the installed SDK's rollback contract using a
   supported, tested mechanism or an independently reviewed deployment design.
   A new SDK version is a separate dependency change, not an automatic fix.
   Preserve a working CA path while any interception can remain registered.
6. The production flag affects all four services, not only API. API-only success
   does not approve global activation: independently verify Go/JWKS, private
   Engine/observation paths and NOW provider contracts using isolated fixtures,
   along with PostgreSQL TCP/TLS availability and a reviewed rollback plan.

Read-only source/control-plane evidence plus the offline fixture cannot approve
production activation alone. Full SDK injection/routing needs an isolated
infrastructure canary. Actual provider acceptance/delivery, authenticated login,
database availability and membership/payment behavior require their own approved
checks; this procedure neither performs nor claims those actions.

References: [Cloudflare outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/),
[Container class](https://developers.cloudflare.com/containers/api/container-class/).
The rollback finding is based on the **installed 0.3.7 source**, not an assumption
that newer documentation provides a missing runtime API.
