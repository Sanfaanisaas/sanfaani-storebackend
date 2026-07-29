import AuditLog from "../models/AuditLog.js";

/**
 * Write an entry to the audit log
 */
export const writeAuditLog = async (actor, action, targetType, targetId, metadata = {}) => {
  return AuditLog.create({
    actor,
    action,
    targetType,
    targetId,
    metadata
  });
};
