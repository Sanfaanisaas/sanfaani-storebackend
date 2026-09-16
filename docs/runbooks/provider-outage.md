# Provider outage runbook

Provider adapters must fail closed for payment, evidence, and authentication transitions. Notification delivery retries five times with bounded backoff and then creates a sanitized dead-letter record. Do not paste raw provider errors, payloads, tokens, or customer data into tickets.

Monitor `/api/ready`, error rate, payment reconciliation cases, notification dead letters, storage cleanup failures, and inventory discrepancies. Recover the provider, replay only documented idempotent work, and retain the incident timeline plus customer-impact evidence.
