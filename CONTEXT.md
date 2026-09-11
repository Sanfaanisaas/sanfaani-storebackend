# Domain Glossary & Architecture Seams

## Core Domain Vocabulary

### Customer Operations Module
High-leverage domain module handling Cart, Checkout, Payments, Orders, Claims, Warranties, and Returns. Encapsulates server-authoritative quote computation, payment verification, and return eligibility rules behind command/query methods.

### Repair & Guidance Lifecycle Module
Deep domain module managing Repair Tracking, Scoped One-Time Credentials, Public Projection filtering, Guidance Sessions, and Advisor Escalations.

### Catalog & Inventory Module
Deep domain module managing Product definitions, Variant SKU configurations, Inventory Units, Locations, and Price-at-add snapshots.

### Support & Staff Module
Deep domain module managing Support Ticket threads, Staff Notifications, Procurement Requests, and Maintenance Plans.

---

## Architectural Principles & Seams

- **Deep Modules**: Modules present small, clean command/query interfaces hiding Mongoose queries, validation invariants, and state machine transitions inside.
- **Thin HTTP Adapters**: Express route handlers act as paper-thin adapters translating HTTP requests into domain module commands.
- **Locality over Layering**: Domain logic, validation rules, and database queries for a single concept live inside the domain module rather than being split across 4 horizontal pass-through layers.
