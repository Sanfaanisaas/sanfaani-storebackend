import mongoose from "mongoose";
import Warranty from "../models/Warranty.js";
import Claim from "../models/Claim.js";
import ReturnRequest from "../models/ReturnRequest.js";
import Order from "../models/Order.js";
import Refund from "../models/Refund.js";
import { CLAIM_STATUS } from "../utils/constants.js";
import { conflict, fingerprint as createFingerprint, idText, isObjectId, listEvidenceSummaries, pageInput, pagination, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { createCustomerNotification } from "./notificationService.js";
import { writeAuditLog } from "./auditService.js";

const activeReturnStates = new Set(["SUBMITTED", "INSPECTION_REQUIRED", "UNDER_INSPECTION", "APPROVED", "REMEDY_IN_PROGRESS", "RESOLVED"]);
const source = (warranty) => (warranty.order ? { sourceType: "order", sourceId: idText(warranty.order) } : { sourceType: "repair", sourceId: idText(warranty.repair) });

const warrantyStatus = async (warranty, session = null, now = new Date()) => {
  if (warranty.status === "VOID") return "void";
  if (warranty.effectiveAt && warranty.effectiveAt > now) return "upcoming";
  if (warranty.expiresAt <= now) return "expired";
  const allowance = warranty.claimAllowance ?? 1;
  const countQuery = Claim.countDocuments({ warranty: warranty._id, active: true });
  if (session) countQuery.session(session);
  const activeClaims = await countQuery;
  if (allowance > 0 && activeClaims >= allowance) return "exhausted";
  return "active";
};

export const projectWarranty = async (warranty, session = null) => {
  const status = await warrantyStatus(warranty, session);
  const countQuery = Claim.countDocuments({ warranty: warranty._id, active: true });
  if (session) countQuery.session(session);
  const activeClaims = await countQuery;
  const allowance = warranty.claimAllowance ?? 1;
  const eligible = status === "active";
  return {
    id: idText(warranty._id),
    ...source(warranty),
    status,
    effectiveAt: warranty.effectiveAt || warranty.issuedAt,
    expiresAt: warranty.expiresAt,
    termsVersion: warranty.policyVersion,
    coverageSummary: warranty.policySnapshot?.coverage || "Coverage details are recorded with this warranty.",
    exclusions: warranty.policySnapshot?.exclusions || [],
    claimEligibility: {
      eligible,
      reasonCode: eligible ? "ELIGIBLE" : status.toUpperCase(),
      customerMessage: eligible ? "This warranty can be used for a claim." : "This warranty is not currently eligible for a new claim.",
    },
    remainingClaimAllowance: allowance > 0 ? Math.max(0, allowance - activeClaims) : null,
    createdAt: warranty.createdAt,
    updatedAt: warranty.updatedAt,
  };
};

export const listWarranties = async ({ owner, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [warranties, total] = await Promise.all([
    Warranty.find({ customer: owner }).sort({ expiresAt: 1 }).skip(skip).limit(limit),
    Warranty.countDocuments({ customer: owner }),
  ]);
  return { warranties: await Promise.all(warranties.map((w) => projectWarranty(w))), pagination: pagination(page, limit, total) };
};

export const getWarranty = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Warranty");
  const warranty = await Warranty.findOne({ _id: id, customer: owner });
  if (!warranty) throw unavailable("Warranty");
  return projectWarranty(warranty);
};

export const warrantyEligibility = async ({ owner, id }) => (await getWarranty({ owner, id })).claimEligibility;

const claimDto = async (claim) => ({
  id: idText(claim._id),
  warranty: { id: idText(claim.warranty) },
  status: claim.status,
  description: claim.description,
  customerSafeTimeline: (claim.customerSafeTimeline || []).map((entry) => ({ status: entry.status, at: entry.at, message: entry.message || null })),
  nextAction: claim.nextAction || null,
  informationRequests: (claim.informationRequests || []).map((item) => ({ id: idText(item._id), message: item.message, dueAt: item.dueAt || null, fulfilledAt: item.fulfilledAt || null })),
  remedy: claim.remedy ? { type: claim.remedy.type || null, summary: claim.remedy.summary || null, outcome: claim.remedy.outcome || null } : null,
  customerSafeReason: claim.customerSafeReason || null,
  evidence: await listEvidenceSummaries({ owner: claim.submittedBy, subjectType: "claim", subject: claim._id }),
  createdAt: claim.createdAt,
  updatedAt: claim.updatedAt,
});

export const createCustomerClaim = async ({ owner, warrantyId, description, idempotencyKey }) => {
  if (!isObjectId(warrantyId)) throw unavailable("Warranty");
  const key = requireIdempotencyKey(idempotencyKey);
  const hash = createFingerprint({ warrantyId, description: description.trim() });

  const existingKeyClaim = await Claim.findOne({ submittedBy: owner, idempotencyKey: key });
  if (existingKeyClaim) {
    if (existingKeyClaim.idempotencyFingerprint !== hash) {
      throw conflict("claim_idempotency_conflict", "This idempotency key is already associated with a different claim request");
    }
    return claimDto(existingKeyClaim);
  }

  const session = await mongoose.startSession();
  try {
    let claim;
    await session.withTransaction(async () => {
      const warranty = await Warranty.findOne({ _id: warrantyId, customer: owner }).session(session);
      if (!warranty) throw unavailable("Warranty");
      const projected = await projectWarranty(warranty, session);
      if (!projected.claimEligibility.eligible) {
        throw conflict("claim_ineligible", projected.claimEligibility.customerMessage);
      }

      const activeClaim = await Claim.findOne({ warranty: warranty._id, active: true }).session(session);
      if (activeClaim) {
        throw conflict("active_claim_exists", "An active claim already exists for this warranty");
      }

      [claim] = await Claim.create(
        [
          {
            warranty: warranty._id,
            repair: warranty.repair || null,
            submittedBy: owner,
            description: description.trim(),
            status: CLAIM_STATUS.SUBMITTED,
            active: true,
            customerSafeTimeline: [{ status: CLAIM_STATUS.SUBMITTED, at: new Date(), message: "Claim submitted" }],
            idempotencyKey: key,
            idempotencyFingerprint: hash,
          },
        ],
        { session }
      );
      await writeAuditLog(owner, "CUSTOMER_CLAIM_CREATED", "Claim", claim._id, { warrantyId }, session);
    });
    return claimDto(claim);
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await Claim.findOne({ submittedBy: owner, idempotencyKey: key });
      if (replay) {
        if (replay.idempotencyFingerprint !== hash) {
          throw conflict("claim_idempotency_conflict", "This idempotency key is already associated with a different claim request");
        }
        return claimDto(replay);
      }
      throw conflict("active_claim_exists", "An active claim already exists for this warranty");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const listClaims = async ({ owner, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [claims, total] = await Promise.all([
    Claim.find({ submittedBy: owner }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Claim.countDocuments({ submittedBy: owner }),
  ]);
  return { claims: await Promise.all(claims.map(claimDto)), pagination: pagination(page, limit, total) };
};

export const getClaim = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Claim");
  const claim = await Claim.findOne({ _id: id, submittedBy: owner });
  if (!claim) throw unavailable("Claim");
  return claimDto(claim);
};

const deliveredAt = (order) => order.deliveredAt || order.completedAt || order.updatedAt;

export const returnEligibility = async ({ owner, orderId, session = null }) => {
  if (!isObjectId(orderId)) throw unavailable("Return eligibility");
  const orderQuery = Order.findOne({ _id: orderId, userId: owner });
  if (session) orderQuery.session(session);
  const order = await orderQuery;
  if (!order) throw unavailable("Return eligibility");

  const receiptAt = deliveredAt(order);
  const deadline = new Date(receiptAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const eligibleStatus = ["delivered", "completed"].includes(order.status);
  const withinWindow = new Date() <= deadline;

  const returnQuery = ReturnRequest.find({ order: order._id, status: { $in: [...activeReturnStates] } }).lean();
  if (session) returnQuery.session(session);
  const existingReturns = await returnQuery;

  const returnedQuantitiesBySku = new Map();
  for (const req of existingReturns) {
    for (const item of req.items) {
      const current = returnedQuantitiesBySku.get(item.variantSku) || 0;
      returnedQuantitiesBySku.set(item.variantSku, current + item.quantity);
    }
  }

  const eligibleItems = [];
  for (const item of order.items) {
    const used = returnedQuantitiesBySku.get(item.variantSku) || 0;
    const remaining = Math.max(0, item.quantity - used);
    if (remaining > 0) {
      eligibleItems.push({
        variantSku: item.variantSku,
        name: item.nameSnapshot,
        quantity: remaining,
      });
    }
  }

  const eligible = eligibleStatus && withinWindow && eligibleItems.length > 0;
  return {
    eligible,
    reasonCode: eligible
      ? "ELIGIBLE_SUBJECT_TO_INSPECTION"
      : !eligibleStatus
      ? "ORDER_NOT_RECEIVED"
      : !withinWindow
      ? "WINDOW_EXPIRED"
      : "NO_ELIGIBLE_ITEMS",
    customerMessage: eligible
      ? "Items are subject to inspection under the approved returns policy."
      : !eligibleStatus
      ? "Returns are available after the order is received."
      : !withinWindow
      ? "The 14-day return window has ended."
      : "No remaining items are eligible for return.",
    eligibleItems,
    deadline,
    availableRemedies: eligible ? ["refund", "replacement"] : [],
    requirements: ["Unused products in original packaging are inspected before a remedy is confirmed."],
  };
};

const refundStatus = (refund) => {
  if (!refund) return { status: "not_applicable", amount: 0, currency: "NGN", initiatedAt: null, completedAt: null, failureAction: null, customerReference: null };
  const statusMap = { RESERVED: "pending_approval", PROVIDER_PENDING: "processing", SUCCEEDED: "completed", FAILED: "failed", CANCELLED: "cancelled" };
  const status = statusMap[refund.status] || "pending_approval";
  return {
    status,
    amount: refund.amount,
    currency: refund.currency,
    initiatedAt: refund.reservedAt || refund.createdAt,
    completedAt: refund.succeededAt || null,
    failureAction: refund.status === "FAILED" ? "Contact support if the refund remains unresolved." : null,
    customerReference: idText(refund._id),
  };
};

const returnDto = async (request) => {
  const refund = request.remedy === "refund" ? await Refund.findOne({ subjectType: "order", subjectId: request.order, owner: request.owner }).sort({ createdAt: -1 }) : null;
  return {
    id: idText(request._id),
    orderId: idText(request.order),
    status: request.status,
    remedy: request.remedy || null,
    items: request.items.map((item) => ({ variantSku: item.variantSku, quantity: item.quantity, acceptedQuantity: item.acceptedQuantity })),
    reason: request.reason,
    customerSafeTimeline: (request.customerSafeTimeline || []).map((entry) => ({ status: entry.status, at: entry.at, message: entry.message || null })),
    nextAction: request.nextAction || null,
    evidence: await listEvidenceSummaries({ owner: request.owner, subjectType: "return_request", subject: request._id }),
    refund: refundStatus(refund),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
};

export const createCustomerReturn = async ({ owner, orderId, items, reason, idempotencyKey, fingerprint }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const existing = await ReturnRequest.findOne({ owner, idempotencyKey: key });
  if (existing) {
    if (existing.idempotencyFingerprint !== fingerprint) {
      throw conflict("return_idempotency_conflict", "This idempotency key is already associated with a different return request");
    }
    return returnDto(existing);
  }

  const session = await mongoose.startSession();
  try {
    let request;
    await session.withTransaction(async () => {
      const eligibility = await returnEligibility({ owner, orderId, session });
      if (!eligibility.eligible) {
        throw conflict("return_ineligible", eligibility.customerMessage);
      }

      const allowed = new Map(eligibility.eligibleItems.map((item) => [item.variantSku, item.quantity]));
      for (const item of items) {
        if (!item || !allowed.has(item.variantSku) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > allowed.get(item.variantSku)) {
          throw conflict("return_item_ineligible", "One or more return items exceed remaining eligible quantity");
        }
      }

      [request] = await ReturnRequest.create(
        [
          {
            order: orderId,
            owner,
            items,
            reason,
            idempotencyKey: key,
            idempotencyFingerprint: fingerprint,
            customerSafeTimeline: [{ status: "SUBMITTED", at: new Date(), message: "Return request submitted" }],
            nextAction: "We will review the returned-item request.",
          },
        ],
        { session }
      );
      await writeAuditLog(owner, "CUSTOMER_RETURN_CREATED", "ReturnRequest", request._id, { orderId, itemCount: items.length }, session);
    });
    return returnDto(request);
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await ReturnRequest.findOne({ owner, idempotencyKey: key });
      if (!replay || replay.idempotencyFingerprint !== fingerprint) {
        throw conflict("return_idempotency_conflict", "This idempotency key is already associated with a different return request");
      }
      return returnDto(replay);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const listReturns = async ({ owner, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [items, total] = await Promise.all([
    ReturnRequest.find({ owner }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    ReturnRequest.countDocuments({ owner }),
  ]);
  return { returns: await Promise.all(items.map(returnDto)), pagination: pagination(page, limit, total) };
};

export const getReturn = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Return request");
  const request = await ReturnRequest.findOne({ _id: id, owner });
  if (!request) throw unavailable("Return request");
  return returnDto(request);
};
