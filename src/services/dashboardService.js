import Repair from "../models/Repair.js";
import Quote from "../models/Quote.js";
import Order from "../models/Order.js";
import Variant from "../models/Variant.js";
import SupportTicket from "../models/SupportTicket.js";
import Payment from "../models/Payment.js";
import Refund from "../models/Refund.js";
import ReconciliationCase from "../models/ReconciliationCase.js";
import AppError from "../utils/AppError.js";
import { USER_ROLES, LOW_STOCK_THRESHOLD, QUOTE_STATUS } from "../utils/constants.js";
import { STAFF_QUEUE_STATUSES } from "../utils/statusContract.js";

const remaining = (dueAt) => dueAt ? Math.floor((new Date(dueAt).getTime() - Date.now()) / 60000) : null;
const queueItem = (doc, type, fields = {}) => ({
  id: doc._id.toString(), type, status: doc.status, dueAt: doc.dueAt || null,
  slaMinutesRemaining: remaining(doc.dueAt), slaState: doc.dueAt ? (remaining(doc.dueAt) < 0 ? "BREACHED" : "ON_TRACK") : "UNSPECIFIED",
  blocked: Boolean(doc.blockerCode), blockerCode: doc.blockerCode || null, blockerMessage: doc.blockerMessage || null,
  priority: doc.priority || "NORMAL", assignedTo: doc.assignedTo || doc.technician || null, updatedAt: doc.updatedAt,
  ...fields,
});

const repairQueue = async (query, type) => (await Repair.find(query).select("status dueAt blockerCode blockerMessage priority assignedTo technician updatedAt customer").lean()).map((repair) => queueItem(repair, type));
const getStoreOperatorQueue = () => repairQueue({ status: { $in: STAFF_QUEUE_STATUSES.store } }, "REPAIR");
const getTechnicianQueue = (user) => repairQueue({ technician: user.id, status: { $in: STAFF_QUEUE_STATUSES.technician } }, "REPAIR");
const getQCOfficerQueue = () => repairQueue({ status: { $in: STAFF_QUEUE_STATUSES.qc } }, "REPAIR");
const getSalesAdvisorQueue = async () => (await Quote.find({ status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.VIEWED] } }).select("status repair version totalAmount updatedAt").lean()).map((quote) => queueItem(quote, "QUOTE", { quoteVersion: quote.version, totalAmount: quote.totalAmount }));
const getInventoryOfficerQueue = async () => (await Variant.find({ $or: [{ sourcing: { $exists: true } }, { inStock: { $lte: LOW_STOCK_THRESHOLD } }] }).select("sku inStock sourcing updatedAt").lean()).map((variant) => ({ id: variant._id.toString(), type: "INVENTORY", status: variant.sourcing ? "SOURCING" : "LOW_STOCK", sku: variant.sku, updatedAt: variant.updatedAt }));
const getFinanceOfficerQueue = async () => {
  const [orders, payments, refunds, reconciliations] = await Promise.all([
    Order.find({ status: { $in: STAFF_QUEUE_STATUSES.financeOrders } }).select("status paymentStatus updatedAt").lean(),
    Payment.find({ status: { $in: ["PENDING", "PROCESSING", "REQUIRES_RECONCILIATION"] } }).select("status subjectType subjectId updatedAt").lean(),
    Refund.find({ status: { $in: ["RESERVED", "PROVIDER_PENDING"] } }).select("status payment amount currency updatedAt").lean(),
    ReconciliationCase.find({ status: "OPEN" }).select("status category payment refund updatedAt").lean(),
  ]);
  return [...orders.map((item) => queueItem(item, "ORDER")), ...payments.map((item) => queueItem(item, "PAYMENT")), ...refunds.map((item) => queueItem(item, "REFUND", { amount: item.amount, currency: item.currency })), ...reconciliations.map((item) => queueItem(item, "RECONCILIATION", { category: item.category }))];
};
export const getSupportOfficerQueue = async () => (await SupportTicket.find({ status: { $in: STAFF_QUEUE_STATUSES.support } }).select("status subject updatedAt").lean()).map((ticket) => queueItem(ticket, "SUPPORT", { subject: ticket.subject }));

const adminQueues = async (user) => ({ STORE: await getStoreOperatorQueue(), TECH: await getTechnicianQueue(user), QC: await getQCOfficerQueue(), SALES: await getSalesAdvisorQueue(), INVENTORY: await getInventoryOfficerQueue(), FINANCE: await getFinanceOfficerQueue(), SUPPORT: await getSupportOfficerQueue() });
export const getQueueForRole = async (user) => {
  switch (user.role) {
    case USER_ROLES.STORE_OPERATOR: return getStoreOperatorQueue();
    case USER_ROLES.TECHNICIAN: return getTechnicianQueue(user);
    case USER_ROLES.QC_OFFICER: return getQCOfficerQueue();
    case USER_ROLES.SALES_ADVISOR: return getSalesAdvisorQueue();
    case USER_ROLES.INVENTORY_OFFICER: return getInventoryOfficerQueue();
    case USER_ROLES.FINANCE_OFFICER: return getFinanceOfficerQueue();
    case USER_ROLES.SUPPORT_OFFICER: return getSupportOfficerQueue();
    case USER_ROLES.OPS_MANAGER:
    case USER_ROLES.SUPER_ADMIN:
    case USER_ROLES.TECH_ADMIN:
    case USER_ROLES.PRODUCT_ADMIN: return adminQueues(user);
    default: throw new AppError("Access denied for this role", 403);
  }
};
