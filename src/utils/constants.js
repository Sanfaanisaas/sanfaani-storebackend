export const ORDER_STATUS = {
  DRAFT: "draft",
  PENDING: "pending",
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
  REQUESTED: "REQUESTED",
  INTAKE_PENDING: "INTAKE_PENDING",
  INTAKE_SCHEDULED: "INTAKE_SCHEDULED",
  RECEIVED: "RECEIVED",
  IN_CUSTODY: "IN_CUSTODY",
  DIAGNOSING: "DIAGNOSING",
  QUOTE_PENDING: "QUOTE_PENDING",
  QUOTE_SENT: "QUOTE_SENT",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  AWAITING_PARTS: "AWAITING_PARTS",
  IN_REPAIR: "IN_REPAIR",
  PAUSED: "PAUSED",
  QC_PENDING: "QC_PENDING",
  QC: "QC",
  READY: "READY",
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  HANDED_OVER: "HANDED_OVER",
  COMPLETED: "COMPLETED",
  DECLINED: "DECLINED",
  CANCELLED: "CANCELLED",
};

export const QUOTE_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  SENT: "SENT",
  VIEWED: "VIEWED",
  ACCEPTED: "ACCEPTED",
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  SUPERSEDED: "SUPERSEDED",
};


export const USER_ROLES = {
  CUSTOMER: "customer",
  SALES_ADVISOR: "sales_advisor",
  STORE_OPERATOR: "store_operator",
  TECHNICIAN: "technician",
  QC_OFFICER: "qc_officer",
  INVENTORY_OFFICER: "inventory_officer",
  SUPPORT_OFFICER: "support_officer",
  FINANCE_OFFICER: "finance_officer",
  MERCHANDISER: "merchandiser",
  OPS_MANAGER: "ops_manager",
  PRODUCT_ADMIN: "product_admin",
  TECH_ADMIN: "tech_admin",
  SUPER_ADMIN: "super_admin",
};

export const PRODUCT_CONDITION = Object.freeze({
  NEW: 'new',
  REFURBISHED_GRADE_A: 'refurbished_grade_a',
  REFURBISHED_GRADE_B: 'refurbished_grade_b',
  USED_GRADE_A: 'used_grade_a',
  USED_GRADE_B: 'used_grade_b',
});

export const LOW_STOCK_THRESHOLD = 5;

export const WARRANTY_PERIOD_DAYS = 90;

export const CLAIM_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  DENIED: 'denied',
  RESOLVED: 'resolved',
});

export const SUPPORT_TICKET_STATUS = Object.freeze({
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
});

export const STOCK_MOVEMENT_REASON = {
  SALE: 'sale',
  RESTOCK: 'restock',
  ADJUSTMENT: 'adjustment',
  RETURN: 'return',
  DAMAGE: 'damage',
};