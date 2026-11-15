Registered members can obtain a permanent referral code without buying a
package or having a binary position. Native Better Auth and the live native
session identify the member. A mounted subject header is an equality fence,
never authority to select another account.

Migration 117 adds two metadata tables. The first authenticated read preserves
an existing, unambiguous legacy code or creates an opaque code for an
unpositioned person. Subsequent placement does not replace that code. There is
no affiliate insertion, package activation, ledger credit or tree mutation.

Attribution is a separate explicit signed POST. An empty referral means the
company affiliate identified by the existing server-side payments root
configuration, validated as a real eligible root. A referral to an unpaid,
unpositioned person records that person as the recruitment sponsor. An
existing affiliate's actual `sponsor_id` always wins; `parent_id` is never used
as a recruitment sponsor. A previously owner-verified legacy hint preserves
its stored sponsor ID even if its old textual alias has since changed.

The own-link GET does not create a company attribution. This prevents a
dashboard read from winning a race against the verified registration's
incoming referral. The capture is immutable after its first accepted
attribution. Existing outstanding orders with conflicting sponsors require
review instead of a silent reassignment.

Both legacy purchase and NOWPayments insert paths have a last-resort SQL
guard. The gated Go precheck reads the authenticated person's stored sponsor
before creating a provider invoice. Missing attribution or a sponsor without
an affiliate produces an explicit review/needs-placement error. It does not
substitute the company or fabricate a tree position. Existing affiliates and
historical financial rows are preserved.

Capture and checkout use the same person-then-attribution lock order. The
first capture updates only its owner's `mlm.person.updated_at` as an explicit
MVCC version fence. A NOWPayments reservation using a prior REPEATABLE READ
snapshot must roll back with `40001` before any provider call. Its existing
local reservation retry starts a fresh snapshot. No other person fields,
identity flags, wallets or tree relationships are changed by capture.

Native APIs are limited to the app portal, use no-store responses and require
the actual native session, exact app Origin and canonical mounted subject.
POST additionally requires the existing signed BFF envelope and a strict
`{ref}` body. The optional root mapping never prevents authentication or
own-link reads from starting; invalid root configuration rejects capture
before SQL. Existing profile V1 functions remain untouched; gated V2 wrappers
project the canonical referral code and pre-activation sponsor.

Local verification uses synthetic PostgreSQL with networking disabled and no
host ports, Bun 1.4.4 and offline Go 1.26.10. The schema harness covers
cross-owner sessions, logout, pending users, legacy aliases and collisions,
cycles, concurrent requests, stored sponsor-ID authority, immutable existing
placement, real totals with only the latest fifty displayed records, both
checkout guards, stale snapshots and outstanding orders. Installation leaves
all old rows and function definitions unchanged. Runtime checks separately
verify the documented timestamp-only exception.
