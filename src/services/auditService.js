import AuditLog from "../models/AuditLog.js";

let testHooks = {};

const financialMetadata = {
  PAYMENT_INITIATED: ["subjectType", "amount", "currency", "purpose", "quoteVersion"],
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
};

const sanitize = (action, metadata) => {
  const allowed = financialMetadata[action];
  if (!allowed) return metadata;
  return Object.fromEntries(allowed.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(metadata, key) ? [[key, metadata[key]]] : []
  )));
};

// Integration tests use this narrowly scoped hook to prove a required audit
// write aborts its containing financial transaction. It is never configured by
// application code.
export const setAuditServiceTestHooks = (hooks = {}) => { testHooks = hooks; };

/**
 * Write an entry to the audit log
 */
export const writeAuditLog = async (actor, action, targetType, targetId, metadata = {}, session) => {
  if (testHooks.beforeWrite) await testHooks.beforeWrite({ actor, action, targetType, targetId, metadata });
  return AuditLog.create([{
    actor,
    action,
    targetType,
    targetId,
    metadata: sanitize(action, metadata)
  }], session ? { session } : undefined).then((records) => records[0]);
};
