# Sanfaani Store API

## Environment setup

Copy `.env.example` to `.env` and replace its placeholder values:

```powershell
Copy-Item .env.example .env
```

The application requires these variables at startup:

- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: secret used to sign access tokens
- `JWT_REFRESH_SECRET`: separate secret used to sign refresh tokens
- `PAYSTACK_SECRET_KEY`: Paystack secret key whose prefix must match `PAYSTACK_MODE`
- `PAYSTACK_CALLBACK_URL`: absolute callback URL required by the environment schema

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

The cookie path is exactly `/api/auth`. Development uses `SameSite=Lax` without
`Secure`; production uses `SameSite=None; Secure` so a configured Vercel origin
can call a separately hosted API. The current frontend normally proxies browser
requests through same-origin `/api`, which is also compatible. Frontends must
send credentials (`credentials: "include"` or Axios `withCredentials: true`).
Credentialed CORS never uses a wildcard. Browser calls to login, refresh and
logout must carry an `Origin` or `Referer` matching an exact `CORS_ORIGIN` entry;
non-browser clients that send neither are supported.

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
family IDs, raw IP values and internal versions. Session and refresh-generation
documents declare TTL cleanup indexes, but every refresh checks revocation and
expiry directly; TTL deletion is not an authorization mechanism.

Authentication errors use `{ "success": false, "message": "...", "errors": [] }`
with stable codes and never expose JWT/MongoDB diagnostics. Security events cover
login success/failure, refresh success/failure/reuse, logout and explicit
revocation. Metadata is bounded and rejects token, cookie, password,
authorization, secret and hash fields; IP addresses are one-way digested. Audit
writes are fail-open and emit only the event name on persistence failure, so an
audit outage does not corrupt an already-committed session transition.

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

```powershell
npm install
npm run dev
```
