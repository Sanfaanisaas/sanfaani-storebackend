export const ORDER_STATUS = {
  DRAFT: "draft",
  PENDING_PAYMENT: "pending_payment",
  PAID: "paid",
  PROCESSING: "processing",
  READY_FOR_PICKUP: "ready_for_pickup",
  DISPATCHED: "dispatched",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  RETURNED: "returned",
  REFUNDED: "refunded",
};

export const PAYMENT_STATUS = {
  INITIATED: "initiated",
  PENDING: "pending",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
};

export const REPAIR_STATUS = {
  REQUESTED: "requested",
  INTAKE_SCHEDULED: "intake_scheduled",
  RECEIVED: "received",
  DIAGNOSING: "diagnosing",
  QUOTE_SENT: "quote_sent",
  AWAITING_APPROVAL: "awaiting_approval",
  APPROVED: "approved",
  AWAITING_PARTS: "awaiting_parts",
  IN_REPAIR: "in_repair",
  PAUSED: "paused",
  QC: "qc",
  READY: "ready",
  HANDED_OVER: "handed_over",
  DECLINED: "declined",
  CANCELLED: "cancelled",
};

export const QUOTE_STATUS = {
  DRAFT: "draft",
  SENT: "sent",
  VIEWED: "viewed",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  EXPIRED: "expired",
  SUPERSEDED: "superseded",
};