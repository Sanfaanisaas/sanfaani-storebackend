# BE-26 Remaining Gates — Reliability, Recovery, and Release Readiness

**Status:** implementation complete; certification pending.

This ticket must not be marked complete until the following evidence exists. The existing readiness endpoint, encrypted backup tooling, isolated restore verifier, release-smoke script, and recovery runbooks are already implemented locally.

## 1. Preserve the local work first

- [ ] Publish or otherwise export local branch `codex/be17-be28-continuation` before the workspace is retired.
- [ ] Confirm the remote contains the BE-17 through BE-26 commits.
- [ ] Do not begin BE-27 certification from an unbacked-up local-only branch.

**Stop condition:** Git hosting authentication or remote branch publication is unavailable. Resolve that before relying on this workspace as the sole copy.

## 2. Run an isolated encrypted backup and restore rehearsal

- [ ] Install or provide trusted MongoDB Database Tools (`mongodump` and `mongorestore`) in the CI/staging environment.
- [ ] Start a disposable local or CI-only MongoDB replica set; do not use development or production MongoDB.
- [ ] Seed non-sensitive fixture data and create an encrypted backup using `scripts/backup-db.mjs`.
- [ ] Confirm the archive, metadata sidecar, and SHA-256 integrity check are produced.
- [ ] Restore only into a separate disposable MongoDB target with `scripts/verify-backup-restore.mjs`.
- [ ] Assert the restored fixture records are present and readable.
- [ ] Record the command, timestamp, tool versions, archive checksum, and pass/fail result in the release evidence.

**Stop conditions:** missing encryption key, checksum mismatch, restore target is not explicitly isolated, restore errors, or restored data differs from the fixture expectation.

## 3. Configure operational monitoring and alert ownership

- [ ] Configure monitoring for `/api/health` (liveness) and `/api/ready` (MongoDB/configuration readiness) from outside the deployment network.
- [ ] Configure alert destinations and named owners for repeated readiness failure, sustained 5xx errors, and backup failure.
- [ ] Test one non-destructive alert path and retain the resulting incident/notification evidence.

**Stop condition:** alerts do not reach an accountable owner, or readiness monitoring exposes sensitive configuration details.

## 4. Validate production configuration without exposing secrets

- [ ] Set the required production backup encryption key through the deployment secret manager; never commit it.
- [ ] Confirm production and staging use distinct database credentials, backup keys, and monitoring credentials.
- [ ] Confirm HTTPS release smoke checks point at the intended environment and return successful health and readiness responses.
- [ ] Confirm scheduled backup ownership, frequency, retention period, and encrypted off-site destination are defined by the operator.

**Stop condition:** any real credential appears in code, logs, shell history, commit history, or documentation; or backups have no verified retention/off-site plan.

## 5. Execute a controlled release drill

- [ ] Run `pnpm test:readiness` and the full regression suite on the release candidate.
- [ ] Run the release smoke script against the approved staging deployment.
- [ ] Perform the documented rollback drill on staging.
- [ ] Verify the backup/restore and rollback runbooks are accurate for the deployed platform.
- [ ] Obtain release-owner sign-off with the evidence from sections 2–4.

**Stop condition:** any regression fails, smoke checks fail, rollback cannot be executed safely, or the recovery rehearsal has not passed.

## Exit criteria for BE-26

BE-26 is complete only when all five sections above are checked and the evidence is retained with the release record. Until then, the backend has reliability tooling but is **not recovery-certified**.

## Next ticket

After BE-26 is certified, begin **BE-27 — full release certification**. Do not start BE-28 production activation until BE-27 passes.
