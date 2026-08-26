# Sanfaani Store API

## Environment setup

Copy `.env.example` to `.env` and replace its placeholder values:

```powershell
Copy-Item .env.example .env
```

The application requires these variables at startup:

- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: independent 32+ character secret used only to sign access tokens
- `JWT_REFRESH_SECRET`: different 32+ character secret used only to sign refresh tokens
- `SECURITY_AUDIT_HMAC_SECRET`: third, distinct 32+ character key used only to
  pseudonymize security-audit and session IP values
- `PAYSTACK_SECRET_KEY`: Paystack secret key whose prefix must match `PAYSTACK_MODE`
- `PAYSTACK_CALLBACK_URL`: absolute callback URL required by the environment schema
- `REPAIR_TRACKING_TOKEN_SECRET`: a distinct 32+ character server secret used
  only to HMAC repair-tracking tokens; raw tracking tokens are never stored

The following variables are optional:

- `NODE_ENV`: runtime mode, normally `development` or `production`
- `PAYSTACK_MODE`: Paystack transaction mode, `test` by default or `live`
- `PORT`: HTTP port; defaults to `5000`
- `SENTRY_DSN`: Sentry project DSN for error monitoring
- `CORS_ORIGIN`: comma-separated exact frontend origins allowed for credentialed
  CORS and cookie-auth CSRF checks; defaults to `http://localhost:3000`

## Authentication sessions (BE-03)

Protected application routes continue to use a bearer access token with a
15-minute lifetime. Login returns that access token in JSON and creates a
database-backed browser/device session. The 30-day refresh token is never
returned in JSON or stored raw: it is set only as the `refreshToken` HttpOnly
cookie and the database stores a keyed SHA-256 digest.

Access and refresh JWTs are separate token domains. Both use only HS256, access
tokens carry `type: "access"`, and refresh tokens carry `type: "refresh"`.
Deploying the strict access-token type check invalidates access tokens issued by
older releases without the type claim. Those tokens last at most 15 minutes,
but affected users may need to sign in again during the rollout.

The cookie path is exactly `/api/auth`. Development uses `SameSite=Lax` without
`Secure`; production uses `SameSite=None; Secure` so a configured Vercel origin
can call a separately hosted API. The current frontend normally proxies browser
requests through same-origin `/api`, which is also compatible. Frontends must
send credentials (`credentials: "include"` or Axios `withCredentials: true`).
Credentialed CORS never uses a wildcard. `CORS_ORIGIN` is a comma-separated list
of credential-free HTTP(S) origins; configured paths, queries and fragments are
rejected. Browser calls to login, refresh and logout must carry an `Origin` or
`Referer` matching an exact serialized origin; non-browser clients that send
neither are supported.

`POST /api/auth/refresh` authenticates only the refresh cookie. It ignores an
absent, expired or malformed bearer header. Every success atomically consumes
the current refresh generation, creates one successor, replaces the cookie and
returns a new access token. Reuse of a rotated or revoked generation revokes the
whole session family, including its successor, and returns `401` with code
`refresh_token_reuse_detected`.

`POST /api/auth/logout` also requires no bearer token. It always clears the
cookie and returns `200`; when a signed, recognized cookie is present (including
an expired one), its server session is revoked. Repeated or malformed-cookie
logout is intentionally idempotent.

Account session endpoints use the normal bearer middleware:

| Endpoint | Success | Behavior |
| --- | --- | --- |
| `GET /api/auth/sessions` | `200` | Lists only this account's sessions. |
| `DELETE /api/auth/sessions/:sessionId` | `200` | Revokes one owned session; unavailable/cross-account IDs return non-enumerating `404`. |
| `DELETE /api/auth/sessions` | `200` | Revokes all sessions for the account and clears the attached refresh cookie. |

The safe session DTO contains only `id`, `createdAt`, `lastUsedAt`, `expiresAt`,
`deviceLabel`, `current`, and `revoked`. It excludes token digests, JWT IDs,
family IDs, IP pseudonyms and internal versions. Raw IP addresses are not stored
in new session or security-audit documents; HMAC-SHA-256 pseudonyms use the
dedicated audit key. Session and refresh-generation
documents declare TTL cleanup indexes, but every refresh checks revocation and
expiry directly; TTL deletion is not an authorization mechanism.

Authentication errors use `{ "success": false, "message": "...", "errors": [] }`
with stable codes and never expose JWT/MongoDB diagnostics. Security events cover
login success/failure, refresh success/failure/reuse, logout and explicit
revocation. Event metadata uses a strict per-event allowlist: approved failure
reasons and the revoke-all count are the only metadata fields retained. Audit
writes are fail-open and emit only an allowlisted event name on persistence
failure, so an audit outage does not corrupt an already-committed session
transition.

### Paystack key mode

`NODE_ENV` controls Node.js runtime behavior. `PAYSTACK_MODE` independently
controls Paystack transaction mode. The application supports these hosted
configurations:

| `NODE_ENV` | `PAYSTACK_MODE` | Required key prefix | Purpose |
| --- | --- | --- | --- |
| `production` | `test` | `sk_test_` | Hosted staging/testing |
| `production` | `live` | `sk_live_` | Real production transactions |

A mismatched key causes startup to fail intentionally. Keep `PAYSTACK_MODE=test`
on Render until live transactions are deliberately enabled. Configure all
Paystack variables in the deployment environment; never put a real Paystack
secret in `.env.example` or commit it to Git.

Never commit `.env` or real credentials. The repository ignores `.env`; `.env.example` contains documentation-only placeholders and is safe to commit.

## Repair tracking and quotes (BE-04 / BE-05)

`POST /api/repairs` is an authenticated customer route. It atomically creates
the repair and a single opaque tracking token. The raw token is returned only in
that creation response. It is 32 random bytes encoded as Base64URL; MongoDB
stores only an HMAC-SHA-256 digest, scoped to `repair:track`, with expiry and
revocation timestamps. The creation route, read route, and rotation route have
separate rate limits.

`GET /api/repairs/:id/track` accepts either the owning customer's bearer token
or `X-Repair-Tracking-Token`. A repair ID is not a credential. Missing,
malformed, expired, revoked, foreign, and unknown credentials deliberately
produce the same `404` envelope. The response is a strict public DTO:

```json
{
  "id": "repair id",
  "status": "QUOTE_SENT",
  "nextAction": "Review the latest quote and accept or decline it.",
  "updatedAt": "2026-08-26T12:00:00.000Z",
  "quote": {
    "id": "quote id",
    "version": 2,
    "lineItems": [{ "description": "Battery replacement", "amount": 12500 }],
    "totalAmount": 12500,
    "estimatedDays": 3,
    "status": "SENT"
  }
}
```

It never includes device, customer, staff, audit, supplier, cost, token, or
other internal fields. Tracking tokens are read-only and cannot accept or
decline a quote. `POST /api/repairs/:id/tracking-token` is owner-only; it
transactionally revokes active prior tracking tokens before returning one new
token once.

Technicians, operations managers, and super administrators create quote
versions with `POST /api/repairs/:id/quote`. The monetary inputs are integer
minor units. Creating a new version transactionally supersedes the preceding
actionable quote, and the `(repair, version)` and one-actionable-quote indexes
make concurrent versioning safe. Sent and accepted line items and totals are
immutable.

Customers accept or decline only the current unexpired quote through
`PATCH /api/repairs/:id/quote/:quoteId/approve` and
`PATCH /api/repairs/:id/quote/:quoteId/decline`. Ownership is enforced in the
database query; unavailable foreign records receive the same `404` response.
The first decision, repair state, accepted-quote snapshot, and audit record
commit in one transaction. Repeating the same decision is idempotent; a
conflicting, superseded, expired, or declined decision returns `409`.

## Payments, refunds, and repair finance gates (BE-06 / BE-07)

`POST /api/payments/attempts` requires an `Idempotency-Key` and an
authenticated owner. It accepts an order or repair reference but derives the
owner, subject type, amount, currency, purpose, and accepted repair quote
version from MongoDB. Each new attempt creates its `Payment` and
`PAYMENT_INITIATED` audit entry in one transaction. Idempotency is scoped to
the owner/key and bound to a SHA-256 fingerprint of all trusted values;
conflicting reuse returns `409`.

The Paystack boundary owns authentication, timeouts, response normalization,
and raw-body HMAC-SHA-512 signature checks. `POST /api/payments/webhook` is the
only callback route. It verifies the signature before parsing, then compares
reference, amount, currency, owner, subject, purpose, and quote version with
the persisted Payment or Refund. Mismatches create a deduplicated, sanitized
reconciliation case and never mutate finance state. Tests inject the provider;
no focused test contacts Paystack.

Refunds are standalone financial aggregates linked to one Payment. They use
integer minor units and immutable subject/owner/purpose/currency/amount
bindings. Payment cached totals obey:

```text
refundedAmount + reservedRefundAmount <= capturedAmount
netPaidAmount = capturedAmount - refundedAmount
```

`POST /api/payments/:paymentId/refunds` is limited to finance officers,
operations managers, and super administrators and is rate-limited. Reservation
uses a conditional database update inside a transaction, so concurrent requests
cannot exceed the captured balance. Refund states are `RESERVED`,
`PROVIDER_PENDING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`; duplicate provider
events are idempotent and contradictory terminal events reconcile without
regression. Provider event and reference identifiers are hashed, histories are
bounded, and raw provider bodies/secrets are never persisted.

Repair finance values are recalculated only from verified Payments and Refunds:
accepted quote total, required deposit, verified paid/refunded, net paid,
outstanding balance, deposit state, gate state, and evaluation time. Work start
requires the verified deposit; QC, ready, and handover require cleared
outstanding balance unless an active scoped finance override applies. Finance
officers, operations managers, and super administrators create
`POST /api/finance/repairs/:repairId/overrides` with a bounded reason and may
revoke an override at
`POST /api/finance/repair-finance-overrides/:overrideId/revoke`. Both preserve
before/after evidence and audit records transactionally; they never rewrite
provider history.

## Order reservation and fulfilment (BE-08)

Checkout now creates an `Order`, an append-only stock-ledger hold, and one
`StockReservation` per order/variant in the same MongoDB transaction. A
reservation is `RESERVED` for fifteen minutes, then moves through `ALLOCATED`,
`CONSUMED`, `RELEASED`, or `EXPIRED`. Checkout’s conditional inventory update
and the reservation uniqueness index prevent concurrent carts from overselling
the same local stock.

A verified payment callback converts all of its order’s `RESERVED` records to
`ALLOCATED` transactionally. A verified failed callback, customer cancellation,
or expiry releases eligible reservations and returns their held quantity through
the same stock ledger exactly once. Run the audited expiry job with an explicit
system actor:

```bash
RESERVATION_EXPIRY_ACTOR_ID=<audited-system-user-objectid> node src/scripts/expire-reservations.js
```

Customers call `PATCH /api/orders/:id/cancel` only for their own unfulfilled
orders; foreign orders are non-enumerating. Store operators, operations
managers, and super administrators call `PATCH /api/orders/:id/dispatch` or
`PATCH /api/orders/:id/collect`. Both require a verified paid order with live
allocated inventory and consume that allocation atomically. Reservation,
allocation, release, expiry, dispatch, and collection writes all have matching
audit records.

## Catalogue contract (BE-01)

### Lifecycle and publication

- `draft` is private and may be incomplete while merchandising work continues.
- `active` is public in both catalogue listing and detail responses.
- `archived` is private and is the soft-delete state.

Every candidate transition to `active` is checked as one aggregate. `POST
/api/products` cannot create an active product directly because no owned variant
can exist yet. `PATCH /api/products/:id` applies all proposed fields to a
candidate before checking it.

A publishable product requires a non-empty name, normalized unique lowercase
slug, description, category, brand, at least one image, and at least one owned
variant. Every owned variant requires a unique SKU, finite non-negative price,
supported condition, exactly one inventory mode, an inspection summary,
structured condition evidence, an explicit known-limitations value (use `None`
when applicable), and versioned warranty terms.

Example publishable variant fields:

```json
{
  "product": "66b86b1c4a0e2f638a70d301",
  "sku": "PHONE-BLK-128",
  "attributes": { "colour": "Black", "storage": "128GB" },
  "price": 125000,
  "condition": "refurbished_grade_a",
  "inspection": {
    "summary": "All documented checks passed",
    "inspectedAt": "2026-08-10T10:00:00.000Z"
  },
  "limitations": "None",
  "conditionEvidence": [
    { "url": "https://example.com/evidence/front.jpg", "alt": "Front condition" }
  ],
  "warranty": {
    "version": "2024-01-01",
    "terms": "Ninety-day limited repair warranty"
  },
  "inStock": 10
}
```

The alternative sourcing mode is the internal object `sourcing: { supplier,
leadTimeDays, costPrice }`. It is mutually exclusive with `inStock`. Legacy
`warrantyTerms`, inspection text, or evidence strings are not promoted or
invented by migration.

Failed publication returns `422` with structured requirements:

```json
{
  "success": false,
  "message": "Publication requirements not met",
  "errors": [
    {
      "code": "product.variants.required",
      "path": "variants",
      "message": "At least one owned variant is required"
    }
  ]
}
```

### Public projections and availability

`GET /api/products` and `GET /api/products/:slug` use the same allowlisted
projection. Public products contain catalogue presentation fields plus public
variants. They do not expose `status`, `__v`, `isActive`, legacy migration
fields, or procurement data. Public variants contain `id`, `sku`, attributes,
price, condition, inspection, limitations, condition evidence, warranty, and
derived availability. They never contain `sourcing`, `supplier`, `costPrice`,
exact `inStock`, `product`, or `__v`.

- `in_stock`: finite local stock is greater than 5.
- `low_stock`: finite local stock is from 1 through 5.
- `out_of_stock`: local stock is zero, absent, negative, or invalid.
- `sourcing`: a sourcing-mode variant, regardless of any corrupt legacy stock value.

Sourcing variants cannot enter a cart, pass checkout, or receive local stock
movements. Checkout repeats product status, ownership, inventory-mode, numeric
stock, and quantity checks inside its transaction before creating an order.

### Catalogue migration procedure

The migration is dry-run by default and reports `scanned`, `changed`, `skipped`,
`invalid`, and `unresolved` totals. It uses raw collection updates so incomplete
legacy records can safely remain drafts. It does not fabricate brand, warranty,
inspection, condition evidence, or limitations, and it never deletes unresolved
records.

1. Back up the target database before review or apply:

   ```bash
   mongodump --uri "$MONGO_URI" --out ./backup-before-be-01
   ```

2. Run and review the default dry-run:

   ```bash
   node scripts/migrate-catalogue.mjs
   ```

3. For an unreferenced variant that has a verified owner, create a reviewed map:

   ```json
   {
     "reviewed": true,
     "mappings": {
       "66b86b1c4a0e2f638a70d302": "66b86b1c4a0e2f638a70d301"
     }
   }
   ```

   Re-run the dry-run with it:

   ```bash
   node scripts/migrate-catalogue.mjs --orphan-map ./reviewed-orphans.json
   ```

4. Only after the totals and mapping are approved, apply explicitly, then run
   the identical apply command a second time; the second `changed` total must be
   zero:

   ```bash
   node scripts/migrate-catalogue.mjs --apply --orphan-map ./reviewed-orphans.json
   node scripts/migrate-catalogue.mjs --apply --orphan-map ./reviewed-orphans.json
   ```

Duplicate ownership, missing references, invalid mappings, and unmapped orphans
remain unresolved for manual review. Do not guess an owner. To roll back an
approved apply, stop application writes and restore the verified backup to the
same target under the normal change-control procedure, for example:

```bash
mongorestore --uri "$MONGO_URI" --drop ./backup-before-be-01
```

**No production catalogue migration was performed as part of BE-01.**

## Run locally

## Private evidence storage (BE-09)

`POST /api/evidence` is the single multipart evidence endpoint. It accepts one
`file` plus `subjectType`, `subjectId`, and `purpose`. The supported signatures
are JPEG, PNG, and PDF; each request is limited to one file and 5 MiB. The
server checks the file signature and submitted MIME consistency, computes a
SHA-256 integrity digest, and generates an opaque random private object key.
Original names, customer identifiers, repair IDs, and serial numbers are never
used in keys. The response is a safe metadata DTO and excludes the key, buffer,
storage credentials, and provider details.

Supported domain/category pairs are `order/order_receipt`,
`repair/repair_intake|custody|qc|handover|warranty`, `claim/warranty`,
`return_request/return`, and `purchase_order/procurement`. Customers are
scoped to their own order, repair, claim, or return record; staff access is
limited by the applicable workflow role and, for technicians, their assigned
repair. Foreign customer subjects and evidence are non-enumerating `404`s;
staff members without a workflow role receive `403`.

`GET /api/evidence/:id/download` rechecks that authorization and returns only a
short-lived signed URL. The URL is neither stored nor logged. The generic
metadata response never exposes an object key. Upload and signed-download
requests are independently rate-limited with the standard error envelope.

Production requires the `OBJECT_STORAGE_*` settings in `.env.example`: an
S3-compatible endpoint, region, private bucket, access key ID, secret access
key, path-style setting, and bounded signed-URL TTL (60–3600 seconds). There is
no production local-disk fallback. Controllers use a storage interface with
`putObject`, `getSignedDownloadUrl`, `deleteObject`, and `headObject`; tests
inject an in-memory adapter and never contact an S3 provider.

Object storage cannot participate in a MongoDB transaction. Upload writes the
object first, then commits evidence metadata and its audit record together; a
metadata failure deletes the object, or queues a bounded cleanup task if that
compensation fails. Deletion first marks evidence `DELETE_PENDING`, deletes the
object, then transactionally marks it `DELETED` with an audit record. A storage
failure returns `202` and leaves an explicit retry task instead of concealing a
partial result. Legal-hold evidence cannot be deleted.

Run bounded orphan/finalization cleanup explicitly (it is never started by app
imports):

```bash
pnpm cleanup:evidence
```

The worker processes at most 50 record-backed tasks per run, uses exponential
backoff and a maximum of five attempts, treats an already absent object as a
successful deletion, and records completion or retry exhaustion safely. It
never scans an arbitrary bucket prefix. Frontends must submit `multipart/form-data`
with a `file` part, must not treat a signed URL as durable, and should refresh a
download URL only through the authenticated endpoint.

```powershell
npm install
npm run dev
```
