# Backup and restore runbook

1. Set `MONGO_URI`, `BACKUP_PATH`, and a distinct 64-hex `BACKUP_ENCRYPTION_KEY` in the protected operations environment.
2. Run `node scripts/backup-db.mjs`; retain the encrypted archive, metadata sidecar, and SHA-256 evidence in company-controlled offsite storage.
3. Verify the ciphertext SHA-256 against the sidecar before decrypting. Restore only into an isolated, disposable MongoDB target and compare collection, document, and index totals before approving production use.
4. Record the backup reference, restore evidence, operator, and recovery-point time in the release record. Never place a production URI or encryption key in a shell history, ticket, or CI log.

Stop immediately if integrity does not match, the restore target is not isolated, or totals differ unexpectedly.
