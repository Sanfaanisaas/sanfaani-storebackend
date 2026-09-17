# Rollback runbook

1. Freeze writes and identify the deployed release and last verified encrypted backup.
2. Roll back application code to the previously certified release; do not rewrite history.
3. If data restoration is required, follow the backup/restore runbook in an isolated rehearsal first, obtain change approval, then execute the approved recovery.
4. Confirm `/api/health` and `/api/ready`, security/error monitoring, payment reconciliation backlog, delivery outbox backlog, storage cleanup, and stock discrepancies.

Stop when a migration is not reversible, backup integrity is uncertain, or the recovery point is outside the approved business window; escalate to the release owner.
