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
- `PUSH_TOKEN_ENCRYPTION_KEY`: a 64-character hexadecimal AES-256 key for encrypted push-device tokens

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

| Endpoint                               | Success | Behavior                                                                               |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `GET /api/auth/sessions`               | `200`   | Lists only this account's sessions.                                                    |
| `DELETE /api/auth/sessions/:sessionId` | `200`   | Revokes one owned session; unavailable/cross-account IDs return non-enumerating `404`. |
| `DELETE /api/auth/sessions`            | `200`   | Revokes all sessions for the account and clears the attached refresh cookie.           |

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

| `NODE_ENV`   | `PAYSTACK_MODE` | Required key prefix | Purpose                      |
| ------------ | --------------- | ------------------- | ---------------------------- |
| `production` | `test`          | `sk_test_`          | Hosted staging/testing       |
| `production` | `live`          | `sk_live_`          | Real production transactions |

A mismatched key causes startup to fail intentionally. Keep `PAYSTACK_MODE=test`
on Render until live transactions are deliberately enabled. Configure all
Paystack variables in the deployment environment; never put a real Paystack
secret in `.env.example` or commit it to Git.

Never commit `.env` or real credentials. The repository ignores `.env`; `.env.example` contains documentation-only placeholders and is safe to commit.

## Notification delivery and push devices (BE-23)

Customer notification preferences persist `email` and `push` consent for optional categories. Security, payment, and transactional notices remain mandatory: they cannot be disabled and atomically create an inbox notification plus durable email/push outbox records. Optional categories with withdrawn consent create neither record.

The delivery worker (`pnpm notification:process`) claims each pending record atomically, uses bounded exponential retry (five attempts), and then records a sanitized dead-letter category. Providers are configured only through deployment environment variables; test providers are injected, so CI never contacts an email or push provider. Provider response IDs are hashed before persistence and provider errors are not stored.

`POST /api/push-devices` registers an owner-scoped installation using `Idempotency-Key`. The raw device ID and push token never appear in API DTOs or persistence: their HMAC digests support lookup, while the push token is AES-256-GCM encrypted at rest. `DELETE /api/push-devices/:id` is owner-scoped and non-enumerating. `POST /api/auth/logout` may include `X-Push-Device-Id` to revoke that owner's installation. Generated notification links are server-side allowlisted paths with no query strings, fragments, or secrets.

## Privacy-safe analytics (BE-24)

`POST /api/analytics/events` accepts only consented, allowlisted product events and small purpose-limited properties. It rejects tokens, credentials, serials, free-form device data, notes, payment payloads, and direct identifiers. Authenticated accounts and anonymous installation identifiers are HMAC-pseudonymized before storage; analytics records expire after 90 days and remain separate from audit and security telemetry.

Trusted server code may record the listed commerce, repair, support, inventory, guidance, and service events. Public callers cannot forge those events. `GET /api/analytics/kpis` is limited to operations managers and super administrators and returns only windowed aggregate event counts—never events, identifiers, or raw analytics properties.

## Versioned API contract (BE-25)

`openapi/sanfaani-api.v1.json` is the committed OpenAPI 3.1 v1 artifact. Export it deterministically with `pnpm openapi:export`; `pnpm openapi:check` regenerates it in a temporary path and fails on drift. CI runs that check before tests. Every route operation has a stable `operationId` and a standard error response, so generated web and mobile clients can depend on the v1 contract. Breaking changes require a new API version or an explicit migration policy; they must not silently replace v1.

## Reliability and recovery (BE-26)

`GET /api/health` is liveness only and does not contact external dependencies. `GET /api/ready` checks MongoDB connectivity and required configuration while returning only sanitized dependency states. Deployment traffic must be gated on readiness, not merely liveness.

The backup command requires a dedicated 64-hex `BACKUP_ENCRYPTION_KEY`, invokes `mongodump` through argument-safe process spawning, encrypts the archive with AES-256-GCM, writes a SHA-256 integrity sidecar, and never prints the database URI. Recovery, rollback, and provider-outage steps are in `docs/runbooks/`; a restore must be rehearsed against an isolated database before any production recovery.

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
    {
      "url": "https://example.com/evidence/front.jpg",
      "alt": "Front condition"
    }
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

## Backend Implementation Tickets & Traceability (BE-14)

The canonical ticket register (BE-10 through BE-31) and PRD traceability matrix have been relocated to dedicated documentation files to prevent numbering collisions:

- `docs/backend-ticket-register.md`
- `docs/backend-prd-traceability.md`

Please refer to these documents for the definition of done for Customer Domains (BE-10), Repair Lifecycle (BE-11), Staff Queues (BE-12), Inventory & Procurement (BE-13), and all remaining R1 production-core blockers.

### Order Fulfilment, Evidence & Tracking (BE-16)

Operational fulfilment transitions are strictly controlled via dedicated mutation endpoints to guarantee inventory integrity and secure evidence collection.

### Manual payments and immutable financial documents (BE-17)

Bank-transfer proof is uploaded by the order owner with
`POST /api/orders/:id/upload-receipt` as a single JPEG, PNG, or PDF `receipt`
part. The object uses the private Evidence storage adapter, an opaque object
key, signature-based file validation, and transactional Evidence metadata. The
response contains safe evidence metadata only; it never contains the object
key or storage credentials. Uploading proof creates or refreshes a pending
canonical `Payment` derived from the stored order amount, currency, owner, and
purpose. It never marks an order paid and cannot change the checkout-selected
payment method.

Only `finance_officer`, `ops_manager`, and `super_admin` may call
`PATCH /api/orders/:id/verify-bank-transfer`. Verification requires active
owner-bound evidence and atomically transitions the canonical Payment to
`SUCCEEDED`, updates the Order payment cache, allocates reservations, writes
allowlisted audit events, and creates immutable invoice and receipt snapshots.
Customer, product-admin, store-operator, missing-evidence, invalid-state, and
mismatched binding paths cannot settle payment.

Pay-on-pickup eligibility is available at
`GET /api/orders/:id/eligible-pickup` (or the compatibility endpoint
`GET /api/orders/eligible-pickup?orderId=...`). Eligibility is calculated only
from the authenticated owner's persisted order total, address, selected method,
policy limit, and server-issued expiry. Query-string totals and addresses are
not trusted. Checkout stores the expiry alongside eligible pay-on-pickup
orders.

`GET /api/orders/:id/invoice` and `GET /api/orders/:id/receipt` are owner-only,
non-enumerating PDF endpoints. An invoice snapshots the order on first issue; a
receipt is available only for a matching, fully captured canonical Payment.
Documents contain integer minor-unit line and total amounts and are rendered
from immutable persisted snapshots, so later Order changes cannot rewrite
historical documents. Snapshots exclude provider references, evidence keys,
storage details, audit internals, and mutable customer/device data.

Run the focused BE-17 suite with:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be17-mongo pnpm test:manual-payment-documents
```

- **Collection (`PATCH /api/orders/:id/collect`)**: Requires explicit identity verification metadata (`identityDocumentType`, `acknowledgedBy`). Completing collection immediately marks the order as delivered and consumes the allocated physical serials.
- **Dispatch (`PATCH /api/orders/:id/dispatch`)**: Requires courier details and tracking references. It formally hands the physical inventory over to a 3rd party, consuming the local allocations.
- **Delivery (`PATCH /api/orders/:id/deliver`)**: A standalone confirmation endpoint for previously dispatched orders to finalize the transit lifecycle.

All fulfilment endpoints require a verified paid order, ensure inventory allocations are consumed exactly once, and generate comprehensive audit logs. Waybills, dispatch notes, and signed customer handover forms can be securely attached to the order via the Private Evidence API using the `dispatch` or `handover` purpose fields.

### Inventory and procurement operations (BE-18)

BE-18 closes the internal inventory lifecycle with staff-only, validated APIs.
Supplier and commercial purchase-order data are never mounted on customer
routes. Inventory officers may read suppliers, manage purchase orders, receive
approved quantities, transfer units, record counts, and perform evidence-backed
adjustments. Supplier creation/update/deactivation, purchase-order approval,
cancellation/explicit closure, and discrepancy resolution require
`ops_manager` or `super_admin` authority.

Purchase orders use controlled `DRAFT -> PENDING_APPROVAL -> APPROVED ->
RECEIVING -> CLOSED` transitions, with `CANCELLED` allowed only before receipt.
Every receipt requires retained purchase-order evidence and an idempotency key.
Non-serialized receipts update aggregate stock once. Serialized receipts create
quarantined units and zero-delta ledger facts; a passed inspection plus an
explicit quarantine release is required before each unit becomes sellable.
Transfer, return-to-stock, release, adjustment, and count-reconciliation paths
use conditional state predicates so concurrent or repeated requests cannot
move or release the same unit twice.

Stock counts require an active location, a bounded reason, retained evidence,
and a payload-bound idempotency key. A mismatch creates one `OPEN`
`StockDiscrepancy`. Only Operations Managers and Super Administrators can
resolve it with `ADJUST_STOCK` or `ACCEPT_NO_CHANGE`; the decision, reason, and
resolution evidence are retained. Any resulting stock delta, its immutable
`StockLedger` fact, and its allowlisted audit event commit in one MongoDB
transaction.

Run the BE-18 suites only against an isolated MongoDB replica set:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be18-mongo pnpm test:inventory-operations
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be18-mongo pnpm test:stock-reconstruction
```

The inventory migration is dry-run by default. Apply mode is blocked unless an
approver, backup evidence reference, and rollback runbook reference are all
provided:

```bash
pnpm inventory:migrate
pnpm inventory:migrate -- --apply \
  --approved-by <staff-object-id> \
  --backup-reference <immutable-backup-reference> \
  --rollback-reference <approved-rollback-runbook-reference>
```

The apply inserts only the opening-balance facts needed to make ledger
reconstruction equal stored stock. A second approved apply creates no duplicate
opening facts. Each apply stores immutable migration evidence and fails its
transaction if reconstruction does not match exactly.

### Organisation quotation-to-order conversion (BE-19)

`POST /api/organisations` creates an organisation and its creator's `OWNER`
membership atomically. `GET /api/organisations/mine` returns active memberships,
while `GET` and `POST /api/organisations/:id/members` expose the controlled
membership boundary. Member management is owner/admin scoped. Purchasing
authority is always resolved from the active persisted membership: `OWNER`,
`ADMIN`, and `BUYER` may purchase; `VIEWER`, revoked members, outsiders, and
forged access-token role claims may not.

New organisation procurement requests include `organisationId`; the supplied
organisation name and type must match that server record. Staff-issued
quotations inherit the organisation binding. After the request owner approves
the current quote, an authorised organisation purchaser converts it with:

```http
POST /api/procurement/quotations/:id/convert
Authorization: Bearer <access-token>
Idempotency-Key: <stable-client-operation-key>
Content-Type: application/json

{
  "organisationId": "<organisation-object-id>",
  "expectedVersion": 1,
  "paymentMethod": "bank_transfer",
  "shippingAddress": {
    "street": "12 Procurement Road",
    "city": "Ibadan",
    "state": "Oyo",
    "postalCode": "200001",
    "country": "Nigeria"
  },
  "purchaseOrderReference": "PO-ACME-2026-001"
}
```

Conversion accepts only an approved, non-superseded, matching-version,
unexpired quotation. A unique database constraint allows exactly one order per
quotation. Identical idempotent replays return that order with
`Idempotency-Replayed: true`; payload drift or another conversion key conflicts.
The order, quote/request transitions, and allowlisted audit event commit in one
MongoDB transaction, so required-audit or persistence failure leaves no partial
order.

The order's immutable `procurementSnapshot` is an explicit allowlist containing
only organisation/request/quotation identifiers, quotation version, line items,
subtotal, tax, fees, fulfilment charge, total, currency, terms version, warranty
and support summaries, validity/approval timestamps, and the optional customer
purchase-order reference. Totals and quote identity are derived from persisted
quotation state; client-supplied financial fields are ignored. Internal
idempotency fingerprints, conversion actor data, audit records, supplier data,
cost prices, procurement operations, and membership internals are excluded.
Invoices for B2B orders use this immutable snapshot and never depend on later
quotation or catalogue changes.

Run the focused suite only against an isolated MongoDB replica set:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be19-mongo pnpm test:b2b-order-conversion
```

### Service execution and maintenance plans (BE-20)

Upgrade, setup, data-migration, and preventive-maintenance work cannot begin
from a request alone. Operations must schedule the latest approved,
non-superseded, unexpired service quotation and assign a persisted technician
account. If the accepted quotation requires a deposit before work, its
server-controlled payment state must confirm the full required amount.
Quotation-creation input cannot set payment state.

The execution lifecycle is explicit and forward-only:

```text
APPROVED request -> SCHEDULED -> IN_PROGRESS -> COMPLETED
                              \-> CANCELLED
```

Scheduling, starting, completion, and cancellation require an
`Idempotency-Key` and an expected aggregate version. Assigned technicians may
start and complete their work; Operations Managers and Super Administrators
may operate the workflow, while cancellation remains operations-only. The
service request, execution, notification, audit event, and completion history
commit transactionally. Completion creates exactly one immutable
`ServiceHistoryEntry`; private scheduling and technician notes never appear in
customer history or API DTOs.

Operations Managers and Super Administrators administer plans through
`POST/GET /api/maintenance-plans`, `PATCH /api/maintenance-plans/:id`, and the
explicit `cancel` and `renew` actions. Customer reads remain owner-scoped under
`/api/maintenance-plans/mine` and `/api/maintenance-plans/:id`. Updates use
optimistic concurrency. Renewal creates a new linked term instead of silently
rewriting the old commercial record; cancellation and renewal are idempotent
and audited. Recurring billing, organisation-wide plan automation, and service
analytics remain deferred to BE-30.

Run the focused suite only against an isolated MongoDB replica set:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be20-mongo pnpm test:service-execution-plans
```

### Controlled staff identity and permissions (BE-21)

Public `/api/auth/register` always creates a customer account. Staff identities
are provisioned only by Product Administrators or Super Administrators through
`POST /api/admin/staff/invitations`. The response returns a 256-bit Base64URL
activation token exactly once; only its SHA-256 digest is stored. The token is
bound to one invited account, expires after 48 hours, and is consumed through
`POST /api/auth/staff-invitations/accept` using the
`X-Staff-Invitation-Token` header. Missing, random, expired, and already-used
tokens share the same non-enumerating response.
Product or Super Administrators may rotate an unaccepted invitation through
`POST /api/admin/staff/:id/invitations`; rotation revokes every earlier active
token and returns the replacement only on its initial response.

The permission register at `GET /api/admin/staff/roles` is application-owned
and read-only. Product Administrators may manage ordinary operational roles.
Operations Manager, Product Administrator, Technical Administrator, and Super
Administrator assignments require a Super Administrator. Administrators
cannot alter their own role or suspension state through these endpoints.

Role changes and suspension/reactivation require the current administrative
version. Each transition increments both the administrative version and the
account's private authentication version, transactionally revokes every active
refresh-token family, and writes an allowlisted audit event. Access tokens
issued by this API carry the authentication version; middleware resolves the
persisted role and active status, so stale role claims and tokens belonging to
suspended accounts fail immediately. Reactivation does not restore prior
sessions.

Staff list/detail projections expose only identity, role, account state,
effective application permissions, concurrency version, and safe timestamps.
Password hashes, activation-token digests, idempotency fingerprints, session
identifiers, status reasons, and audit internals are excluded.

Run the focused suite only against an isolated MongoDB replica set:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be21-mongo pnpm test:staff-identity
```

### Versioned content and policy publication (BE-22)

Content pages and policy documents are immutable per-version records. Editors
create drafts with a payload-bound `Idempotency-Key`, submit them for review,
and a Product or Super Administrator independently approves and publishes
them. The controlled lifecycle is `DRAFT → IN_REVIEW → APPROVED → PUBLISHED`;
publishing a replacement transactionally marks the prior public version
`SUPERSEDED`. Non-current versions may be archived. Every state change is
audited and uses `expectedStateVersion` optimistic concurrency.

Public reads require no credentials and return only the current published
version through `GET /api/content/pages/:slug` or
`GET /api/content/policies/:key`. Drafts, workflow state, authors, reviewers,
idempotency data, and audit metadata are excluded. Preview and mutation routes
under `/api/content/admin/*` require a Merchandiser, Product Administrator, or
Super Administrator as appropriate; draft creators cannot approve their own
version.

The nine stable launch-policy keys are:

- `terms_of_sale`
- `warranty_policy`
- `returns_refund_policy`
- `repair_custody_terms`
- `device_data_backup_acknowledgement`
- `privacy_notice`
- `cookie_analytics_notice`
- `delivery_pickup_policy`
- `b2b_quotation_terms`

Checkout, repair intake, warranty, return, evidence, B2B procurement, and
service records capture immutable `{ policyVersionId, key, version,
acceptedAt }` snapshots from the currently published policy records. Existing
records therefore retain the exact terms that applied even after publication
of a replacement. A current policy cannot be deleted, and any superseded or
archived policy referenced by one of these records is also deletion-protected.
BE-28 readiness must confirm all nine keys have a published version before
production activation.

Run the focused suite only against an isolated MongoDB replica set:

```bash
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be22-mongo pnpm test:content-policy
```

## Run locally

```powershell
npm install
npm run dev
```
