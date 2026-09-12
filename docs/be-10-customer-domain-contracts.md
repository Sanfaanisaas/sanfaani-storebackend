# BE-10 Customer Domain API & Security Contracts

_Note: This document canonically defines ticket BE-10. See `docs/backend-ticket-register.md` for the full repository ticket roadmap and domain mapping._

## Overview

# BE-10 Customer Domain API & Security Contracts

## Overview

BE-10 covers customer-facing domain APIs and frontend integration contracts for Sanfaani Store Backend:

- Warranties & Warranty Eligibility
- Warranty Claims
- Returns & Customer Refund Progression
- Support Tickets & Replies
- Notifications & Notification Preferences
- Guidance Sessions & Advisor Escalation
- Customer Procurement Requests & Quotations
- Upgrade, Setup & Maintenance Service Requests
- Service Quotations
- Maintenance Plans & Customer Service History

---

## BE-10 Endpoints & Authorization Matrix

| Endpoint                                                        | Method          | Role / Auth                                                                | Idempotency       | Description                           |
| --------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| `/api/warranties/mine`                                          | GET             | `customer`                                                                 | No                | List customer's owned warranties      |
| `/api/warranties/:id/eligibility`                               | GET             | `customer`                                                                 | No                | Derived server-side claim eligibility |
| `/api/warranties/:id`                                           | GET             | `customer`                                                                 | No                | Owner warranty detail projection      |
| `/api/warranties/:id/claims`                                    | POST            | `customer`                                                                 | `Idempotency-Key` | File a warranty claim                 |
| `/api/claims/mine`                                              | GET             | `customer`                                                                 | No                | List customer's claims                |
| `/api/claims/:id`                                               | GET             | `customer`                                                                 | No                | Owner claim detail projection         |
| `/api/claims/:id/status`                                        | PATCH           | Staff (`support_officer`, `ops_manager`, `super_admin`)                    | No                | Staff claim status transition         |
| `/api/returns/orders/:orderId/eligibility`                      | GET             | `customer`                                                                 | No                | Derived order return eligibility      |
| `/api/returns/orders/:orderId`                                  | POST            | `customer`                                                                 | `Idempotency-Key` | Submit a return request               |
| `/api/returns/mine`                                             | GET             | `customer`                                                                 | No                | List customer's returns               |
| `/api/returns/:id`                                              | GET             | `customer`                                                                 | No                | Owner return request detail           |
| `/api/returns/:id/decision`                                     | PATCH           | Staff (`support_officer`, `finance_officer`, `ops_manager`, `super_admin`) | No                | Record staff return decision          |
| `/api/support-tickets/mine`                                     | GET             | `customer`                                                                 | No                | List customer support tickets         |
| `/api/support-tickets`                                          | POST            | `customer`                                                                 | `Idempotency-Key` | Create a support ticket               |
| `/api/support-tickets/:id`                                      | GET             | `customer`                                                                 | No                | Owner support ticket detail           |
| `/api/support-tickets/:id/reply`                                | POST            | `customer` or Staff                                                        | `Idempotency-Key` | Reply to support ticket               |
| `/api/support-tickets/:id/status`                               | PATCH           | Staff                                                                      | No                | Update support ticket status          |
| `/api/notifications`                                            | GET             | `customer`                                                                 | No                | List unexpired customer notifications |
| `/api/notifications/unread-count`                               | GET             | `customer`                                                                 | No                | Count unread notifications            |
| `/api/notifications/:id/read`                                   | PATCH           | `customer`                                                                 | No                | Mark notification read                |
| `/api/notifications/read-all`                                   | POST            | `customer`                                                                 | No                | Mark all notifications read           |
| `/api/notification-preferences`                                 | GET / PATCH     | `customer`                                                                 | No                | Get / update notification preferences |
| `/api/guidance/mine`                                            | GET             | `customer`                                                                 | No                | List customer guidance sessions       |
| `/api/guidance`                                                 | POST            | Optional Auth / Guest                                                      | No                | Create guidance session               |
| `/api/guidance/:id`                                             | GET             | Optional Auth / `X-Guidance-Resume-Token`                                  | No                | Resume guidance session               |
| `/api/guidance/:id/escalations/current`                         | GET             | `customer`                                                                 | No                | Get active advisor escalation         |
| `/api/guidance/:id/escalations`                                 | POST            | `customer`                                                                 | No                | Request advisor escalation            |
| `/api/guidance/:id/archive`                                     | PATCH           | `customer`                                                                 | No                | Archive guidance session              |
| `/api/guidance/escalations/:id/respond`                         | POST            | Staff (`sales_advisor`, `support_officer`, `ops_manager`, `super_admin`)   | No                | Respond to advisor escalation         |
| `/api/procurement/requests`                                     | POST            | `customer`                                                                 | `Idempotency-Key` | Create procurement request            |
| `/api/procurement/requests/mine`                                | GET             | `customer`                                                                 | No                | List customer procurement requests    |
| `/api/procurement/requests/:id`                                 | GET             | `customer`                                                                 | No                | Owner procurement request detail      |
| `/api/procurement/requests/:id`                                 | PATCH           | `customer`                                                                 | No                | Update editable procurement request   |
| `/api/procurement/requests/:id/clarifications/:clarificationId` | POST            | `customer`                                                                 | No                | Respond to clarification              |
| `/api/procurement/requests/:id/quotations`                      | GET / POST      | `customer` (GET) / Staff (POST)                                            | No                | List / Issue procurement quote        |
| `/api/procurement/quotations/:id`                               | GET             | `customer`                                                                 | No                | Get procurement quotation detail      |
| `/api/procurement/quotations/:id/approve`                       | POST            | `customer`                                                                 | `Idempotency-Key` | Approve procurement quotation         |
| `/api/procurement/quotations/:id/decline`                       | POST            | `customer`                                                                 | `Idempotency-Key` | Decline procurement quotation         |
| `/api/services/policy`                                          | GET             | `customer`                                                                 | No                | Service responsibility policy         |
| `/api/services/requests`                                        | POST            | `customer`                                                                 | `Idempotency-Key` | Create service request                |
| `/api/services/requests/mine`                                   | GET             | `customer`                                                                 | No                | List customer service requests        |
| `/api/services/requests/:id`                                    | GET             | `customer`                                                                 | No                | Get service request detail            |
| `/api/services/requests/:id/assessment`                         | GET / PATCH     | `customer` (GET) / Staff (PATCH)                                           | No                | Assessment detail / recording         |
| `/api/services/requests/:id/quotations`                         | GET / POST      | `customer` (GET) / Staff (POST)                                            | No                | List / Issue service quotation        |
| `/api/services/quotations/:id`                                  | GET             | `customer`                                                                 | No                | Get service quotation detail          |
| `/api/services/quotations/:id/approve`                          | POST            | `customer`                                                                 | `Idempotency-Key` | Approve service quotation             |
| `/api/services/quotations/:id/decline`                          | POST            | `customer`                                                                 | `Idempotency-Key` | Decline service quotation             |
| `/api/services/history`                                         | GET / GET `:id` | `customer`                                                                 | No                | Customer service history              |
| `/api/maintenance-plans/mine`                                   | GET / GET `:id` | `customer`                                                                 | No                | Customer maintenance plans            |

---

## Security & Non-Enumeration

1. **Owner Isolation**:
   Resource queries enforce `{ _id: id, customer: userId }` or equivalent canonical owner fields.
2. **Non-Enumeration**:
   When a resource ID is foreign, random ObjectId, or malformed, the API responds with a non-enumerating 404 (e.g. `warranty_unavailable`, `claim_unavailable`, `support_ticket_unavailable`).
3. **Guidance Guest Resume Token**:
   Guest resume tokens are generated with 32 random bytes (`base64url`), hashed with HMAC-SHA-256 (`resumeDigest`), and accepted ONLY via the `X-Guidance-Resume-Token` header for `GET /api/guidance/:id`. Resume tokens cannot authorize mutations or non-guidance endpoints.

---

## State Transition Matrices & Concurrency

- **Claims**: `submitted` -> `screening` -> `inspection_required` / `approved` / `rejected` -> `under_inspection` -> `approved` / `rejected` -> `remedy_in_progress` -> `resolved` -> `closed`. Terminal states (`closed`, `cancelled`, `rejected`) reject further transitions. Conditional status updates (`Claim.findOneAndUpdate({ _id, status: currentStatus }, ...)`) prevent conflicting concurrent decisions.
- **Returns**: `SUBMITTED` -> `INSPECTION_REQUIRED` / `UNDER_INSPECTION` / `APPROVED` / `REJECTED` -> `REMEDY_IN_PROGRESS` -> `RESOLVED` / `CANCELLED`. Return item quantity accounting calculates remaining available quantities across all active/completed returns per order inside a MongoDB transaction.
- **Procurement & Service Quotations**: Actionable quotes require exact version matching (`version`) and valid expiry. Accepting or declining a quote updates both quotation and request status atomically inside a MongoDB transaction.

---

## Test Execution Commands

```bash
# Focused BE-10 Integration Suites
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:customer-warranties
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:customer-returns
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:support-notifications
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:customer-guidance
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:customer-procurement
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:customer-services

# Delegated BE-00–BE-09 Baseline Regression Suites
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:auth-session
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:catalogue
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:cart-checkout
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:repair-tracking
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:quote-lifecycle
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:payments
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:payment-transitions
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:repair-gates
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:fulfilment
MONGOMS_DOWNLOAD_DIR=/tmp/sanfaani-be10-mongo pnpm test:evidence-storage
```

---

## External Dependencies Owned by BE-00–BE-09

- BE-01: Public Catalogue & Variant Availability (`Variant.find()`, `deriveAvailability()`)
- BE-02: Order Owner & State Verification (`Order.findOne()`)
- BE-03: Auth Session & JWT Token Verification (`verifyAccessToken()`)
- BE-06: Refund Lifecycle & Payment Transitions (`Refund.findOne()`)
- BE-09: Evidence Metadata Storage Interface (`listEvidenceSummaries()`, `documentMetadata()`)
