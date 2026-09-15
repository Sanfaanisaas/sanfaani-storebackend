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
  BANK_TRANSFER_EVIDENCE_ATTACHED: ["amount", "currency"],
  BANK_TRANSFER_VERIFIED: ["amount", "currency"],
  // ... existing metadata ...
  ORDER_DISPATCHED: ["allocationState"],
  ORDER_COLLECTED: ["allocationState"],
  ORDER_DELIVERED: [],
  ORDER_CANCELLED: ["actorRole"],
  INVENTORY_ALLOCATION_CONSUMED: ["orderId", "quantity"],
  INVENTORY_UNIT_CONSUMED: ["orderId", "serial"],
  STOCK_MOVEMENT_RECORDED: ["delta", "reason", "resultingStock", "sourceType"],
  INVENTORY_UNIT_TRANSITIONED: ["action", "reason", "evidenceId", "fromState", "toState"],
  STOCK_COUNT_RECORDED: ["expectedQuantity", "countedQuantity", "status", "reason", "evidenceId"],
  STOCK_DISCREPANCY_RESOLVED: ["resolution", "variance", "reason", "evidenceId"],
  SUPPLIER_CREATED: ["active"],
  SUPPLIER_UPDATED: ["fields"],
  SUPPLIER_DEACTIVATED: ["reason"],
  PURCHASE_ORDER_CREATED: ["status", "lineCount"],
  PURCHASE_ORDER_SUBMITTED: ["status"],
  PURCHASE_ORDER_APPROVED: ["status"],
  PURCHASE_ORDER_CANCELLED: ["status", "reason"],
  PURCHASE_ORDER_CLOSED: ["status", "reason"],
  PURCHASE_ORDER_RECEIVED: ["quantity", "status", "evidenceId", "serialized"],
  INVENTORY_MIGRATION_APPLIED: ["inspectedCount", "openingEntriesCreated", "reconstructionMismatched"],
  ORGANISATION_CREATED: ["type"],
  ORGANISATION_MEMBER_UPDATED: ["role", "canPurchase"],
  B2B_QUOTATION_CONVERTED: ["organisationId", "orderId", "quotationVersion", "totalAmount", "currency"],
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
