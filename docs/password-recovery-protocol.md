# Email-owned password creation and recovery

## User protocol

Use `/forgot-password` from the portal's **Crear o cambiar contraseña** link.
Enter the original registered email, request a recovery code, then provide its
six digits and a new password twice (12–128 characters, preserved exactly).
After a confirmed change, sign in normally; recovery does not create a session.
It works for an existing credential, an absent credential or an empty credential
on the same Better Auth user. Never recover, copy or send a legacy password.

The request acknowledgement is intentionally neutral. It is not proof that an
account exists, has a password, is allowed network access or received a message.
There is no public account/password-status lookup and no username-to-email API.
Do not share codes or passwords with support. Correcting an entered email is not
changing the email registered on the account; lost-mailbox cases need review.

## Eligibility and administrative support

| State | Safe path |
| --- | --- |
| Existing allowed access with a password | Normal password/OTP login, or recovery to replace it |
| Existing allowed access without a password | Same recovery flow creates its first credential after email proof |
| Eligible legacy account missing access | Provision only a pending, unverified principal under the reviewed migration policy |
| Suspended, blacklisted, deleted or ambiguous legacy account | Separate explicit administrative review; recovery must not lift restrictions |
| Lost original mailbox or requested new email | Separate identity/email-change review, never anonymous recovery |

An explicitly authorized, scoped operator reactivation is independent of OTP.
It must preserve immutable identity, placement, sponsor and financial records,
check other blacklist match keys, take a private encrypted before-image and
append an honest audit record. It may create a pending principal only: no
credential, verified email, session, role or binding is fabricated. Actual email
proof and the existing identity-linking policy remain required afterwards.

## Runtime contract and guards

- `POST /api/auth/email-otp/request-password-reset` accepts only normalized email.
- `POST /api/auth/email-otp/reset-password` accepts email, recovery OTP and exact
  password. The purpose is `forget-password`, not sign-in or registration.
- BFF requires exact origin, JSON, bounded input and a trusted signed client IP.
  It strips cookies and caller-selected purposes, roles, identity IDs, new email
  and redirects. Only HTTP200 with exactly `{success:true}` projects `{ok:true}`.
  Reset never relays cookies, JWTs, locations or account-existence diagnostics.
- Core allows only those two exact auth POSTs under existing auth readiness;
  queries, aliases, other hosts/methods, phone, change-email, token POST and the
  optional non-consuming code checker remain closed. Financial gates unchanged.
- Better Auth1.6.22 hashes the password and creates/updates its own credential.
  An OTP is HMAC-stored, single-use, expires in300 seconds, allows three attempts
  and shares the existing persistent recipient resend budget. Input is checked
  before the installed reset can consume a code for an invalid password.
- Successful reset verifies email possession and revokes existing auth sessions,
  but does not sign in or provision a legacy binding. A subsequent verified
  login still follows the canonical identity/permission policy.

## Failure boundaries and operations

An accepted send is not a delivery claim; unknown recipients receive the same
acknowledgement without registration. Delivery failure or timeout must not cause
an automatic resend. Keep a possibly delivered code entry available and respect
at least300 seconds or a longer `Retry-After`. Browser send/redemption budgets
are30/12 seconds; signed server transport retains20/8 seconds respectively.

The installed adapter deliberately uses `transaction:false`. Native1.6.22 spends
the OTP, saves the credential, verifies email and revokes sessions sequentially.
A later database/revocation failure can leave the password changed despite an
error. Do not claim rollback or automatically retry: first try normal sign-in
with the new password, then request another recovery code if necessary. A future
transactional upgrade needs separate review of identity hooks and guarded CAS.

No auth migration, global grant, new provider subscription, email change,
financial mutation or historical-password import is needed for this release.
Passwords, OTPs, recipient payloads and tokens must not enter logs or public
repository artifacts. Account-specific operator evidence stays private.

Verification: real installed Better Auth handlers with synthetic delivery,
credential-present/absent/empty, wrong purpose, replay, expiry, attempt budgets,
resend, revocation and error boundaries; BFF false acknowledgements/privacy;
UI races/unmount and generic states; exact Core route-denial tests; offline
Linux/OpenNext/workerd. Production checks must not send a code or create a real
session merely to demonstrate the deployment.

Reference: [Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp).
