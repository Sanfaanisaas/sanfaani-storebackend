import Repair from "../models/Repair.js";
import Quote from "../models/Quote.js";
import Order from "../models/Order.js";
import Variant from "../models/Variant.js";
import SupportTicket from "../models/SupportTicket.js";
import AppError from "../utils/AppError.js";
import { USER_ROLES, LOW_STOCK_THRESHOLD } from "../utils/constants.js";

const getStoreOperatorQueue = async () => {
  return Repair.find({ status: { $in: ['requested', 'intake_scheduled'] } })
    .populate('customer', 'name email');
};

const getTechnicianQueue = async (user) => {
  return Repair.find({ 
    technician: user.id, 
    status: { $in: ['diagnosing', 'awaiting_parts', 'in_repair', 'paused'] } 
  }).populate('customer', 'name email');
};

const getQCOfficerQueue = async () => {
  return Repair.find({ status: 'qc' })
    .populate('customer', 'name email')
    .populate('technician', 'name');
};

const getSalesAdvisorQueue = async () => {
  return Quote.find({ status: { $in: ['sent', 'viewed'] } })
    .populate('repair', 'customer device')
    .populate({
      path: 'repair',
      populate: { path: 'customer', select: 'name email' }
    });
};

const getInventoryOfficerQueue = async () => {
  // variants filtered to derived stockStatus in ['limited', 'sourcing']
  // Sourcing variants are those where sourcing field exists. 
  // inStock variants are limited if inStock <= LOW_STOCK_THRESHOLD
  return Variant.find({
    $or: [
      { sourcing: { $exists: true } },
      { inStock: { $lte: LOW_STOCK_THRESHOLD } }
    ]
  });
};

const getFinanceOfficerQueue = async () => {
  return Order.find({ paymentMethod: 'bank_transfer', status: 'pending' })
    .populate('userId', 'name email');
};

export const getSupportOfficerQueue = async () => {
  return SupportTicket.find({ status: { $in: ['open', 'in_progress'] } })
    .populate('customer', 'name email')
    .sort({ updatedAt: -1 });
};

export const getQueueForRole = async (user) => {
  const role = user.role;

  switch (role) {
    case USER_ROLES.STORE_OPERATOR:
      return await getStoreOperatorQueue();
    case USER_ROLES.TECHNICIAN:
      return await getTechnicianQueue(user);
    case USER_ROLES.QC_OFFICER:
      return await getQCOfficerQueue();
    case USER_ROLES.SALES_ADVISOR:
      return await getSalesAdvisorQueue();
    case USER_ROLES.INVENTORY_OFFICER:
      return await getInventoryOfficerQueue();
    case USER_ROLES.FINANCE_OFFICER:
      return await getFinanceOfficerQueue();
    case USER_ROLES.SUPPORT_OFFICER:
      return await getSupportOfficerQueue();
    
    case USER_ROLES.OPS_MANAGER:
    case USER_ROLES.SUPER_ADMIN:
    case USER_ROLES.TECH_ADMIN:
    case USER_ROLES.PRODUCT_ADMIN:
      // Per ticket: confirm combined or tabs. Defaulting to combined object for now as it's backend.
      return {
        store_operator: await getStoreOperatorQueue(),
        technician: await getTechnicianQueue(user),
        qc_officer: await getQCOfficerQueue(),
        sales_advisor: await getSalesAdvisorQueue(),
        inventory_officer: await getInventoryOfficerQueue(),
        finance_officer: await getFinanceOfficerQueue(),
        support_officer: await getSupportOfficerQueue()
      };

    default:
      throw new AppError("Access denied for this role", 403);
  }
};
