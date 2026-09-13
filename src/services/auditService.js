import AuditLog from "../models/AuditLog.js";

let testHooks = {};

const allowlistedMetadata = {
  PAYMENT_INITIATED: [
    "subjectType",
    "amount",
    "currency",
    "purpose",
    "quoteVersion",
  ],
  PAYMENT_SETTLED: ["subjectType", "amount", "currency"],
  PAYMENT_SETTLEMENT_DUPLICATE: ["eventDigest"],
  PAYMENT_SETTLEMENT_REJECTED: ["category", "eventDigest"],
  REFUND_RESERVED: ["amount", "currency", "refundStatus"],
  REFUND_PROVIDER_PENDING: ["refundStatus", "eventDigest"],
  REFUND_SUCCEEDED: ["amount", "currency", "refundStatus", "eventDigest"],
  REFUND_FAILED: ["refundStatus", "failureCategory", "eventDigest"],
  REFUND_CANCELLED: ["refundStatus"],
  RECONCILIATION_CREATED: ["category", "eventDigest", "occurrenceCount"],
  RECONCILIATION_REOBSERVED: ["category", "eventDigest", "occurrenceCount"],
  EVIDENCE_UPLOADED: ["subjectType", "purpose", "size"],
  EVIDENCE_DOWNLOAD_AUTHORIZED: ["subjectType", "purpose"],
  EVIDENCE_DELETE_REQUESTED: ["subjectType", "purpose"],
  EVIDENCE_DELETED: ["subjectType", "purpose"],
  EVIDENCE_CLEANUP_COMPLETED: ["taskType", "attempts"],
  EVIDENCE_CLEANUP_EXHAUSTED: ["taskType", "attempts"],
  // ... existing metadata ...
  ORDER_DISPATCHED: ["allocationState"],
  ORDER_COLLECTED: ["allocationState"],
  ORDER_DELIVERED: [],
  ORDER_CANCELLED: ["actorRole"],
  INVENTORY_ALLOCATION_CONSUMED: ["orderId", "quantity"],
  INVENTORY_UNIT_CONSUMED: ["orderId", "serial"],
};

const sanitize = (action, metadata) => {
  const allowed = allowlistedMetadata[action];
  if (!allowed) return metadata;
  return Object.fromEntries(
    allowed.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(metadata, key)
        ? [[key, metadata[key]]]
        : [],
    ),
  );
};

// Integration tests use this narrowly scoped hook to prove a required audit
// write aborts its containing financial transaction. It is never configured by
// application code.
export const setAuditServiceTestHooks = (hooks = {}) => {
  testHooks = hooks;
};

/**
 * Write an entry to the audit log
 */
export const writeAuditLog = async (
  actor,
  action,
  targetType,
  targetId,
  metadata = {},
  session,
) => {
  if (testHooks.beforeWrite)
    await testHooks.beforeWrite({
      actor,
      action,
      targetType,
      targetId,
      metadata,
    });
  return AuditLog.create(
    [
      {
        actor,
        action,
        targetType,
        targetId,
        metadata: sanitize(action, metadata),
      },
    ],
    session ? { session } : undefined,
  ).then((records) => records[0]);
};
