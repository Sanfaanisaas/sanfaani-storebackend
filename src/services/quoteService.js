import mongoose from "mongoose";
import Quote from "../models/Quote.js";
import Repair from "../models/Repair.js";
import AppError from "../utils/AppError.js";
import { QUOTE_ACTIONABLE_STATUSES, QUOTE_STATUS, REPAIR_STATUS, USER_ROLES } from "../utils/constants.js";
import { writeAuditLog } from "./auditService.js";
import { assertRepairFinanceGate } from "./repairFinanceService.js";
import { createCustomerNotification } from "./notificationService.js";

const QUOTE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_DECISION_ROLES = new Set([USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN]);
const unavailable = () => new AppError("Quote information is unavailable", 404, [{ code: "quote_unavailable", message: "Check the repair reference and quote credentials" }]);
const conflict = (code, message) => new AppError(message, 409, [{ code, message }]);
const validId = (value) => typeof value === "string" && mongoose.isObjectIdOrHexString(value);

const assertLineItems = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw new AppError("A quote requires at least one line item", 400);
  for (const item of lineItems) {
    if (!item || typeof item.description !== "string" || !item.description.trim() || !Number.isSafeInteger(item.amount) || item.amount < 0) {
      throw new AppError("Quote line items must contain a description and a non-negative integer minor-unit amount", 400);
    }
  }
};

const getDecisionRepair = async (repairId, actorId, actorRole, session) => {
  if (!validId(repairId) || !validId(actorId)) throw unavailable();
  const repair = await Repair.findById(repairId).session(session);
  if (!repair || (repair.customer.toString() !== actorId && !ADMIN_DECISION_ROLES.has(actorRole))) throw unavailable();
  return repair;
};

export const createNewQuoteVersion = async (repairId, lineItems, userId, { estimatedDays = 3, expiresAt } = {}) => {
  if (!validId(repairId) || !validId(userId)) throw unavailable();
  assertLineItems(lineItems);
  if (!Number.isSafeInteger(estimatedDays) || estimatedDays < 0 || estimatedDays > 365) throw new AppError("estimatedDays must be a whole number between 0 and 365", 400);
  const now = new Date();
  const quoteExpiresAt = expiresAt ? new Date(expiresAt) : new Date(now.getTime() + QUOTE_TTL_MS);
  if (Number.isNaN(quoteExpiresAt.valueOf()) || quoteExpiresAt <= now) throw new AppError("Quote expiry must be a future UTC timestamp", 400);
  const totalAmount = lineItems.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(totalAmount)) throw new AppError("Quote total exceeds supported integer minor units", 400);

  const session = await mongoose.startSession();
  try {
    let quote;
    await session.withTransaction(async () => {
      if (!await Repair.exists({ _id: repairId }).session(session)) throw unavailable();
      await Quote.updateMany({ repair: repairId, isActionable: true }, { $set: { status: QUOTE_STATUS.SUPERSEDED, isActionable: false } }, { session });
      const repair = await Repair.findOneAndUpdate({ _id: repairId }, { $inc: { quoteVersionCounter: 1 }, $set: { status: REPAIR_STATUS.QUOTE_SENT } }, { returnDocument: "after", session, runValidators: true }).select("+quoteVersionCounter");
      quote = (await Quote.create([{
        repair: repairId,
        version: repair.quoteVersionCounter,
        lineItems: lineItems.map(({ description, amount }) => ({ description: description.trim(), amount })),
        totalAmount,
        estimatedDays,
        status: QUOTE_STATUS.SENT,
        isActionable: true,
        expiresAt: quoteExpiresAt,
        createdBy: userId,
      }], { session }))[0];
      await writeAuditLog(userId, "QUOTE_SENT", "Quote", quote._id, { repairId: repairId.toString(), version: quote.version, totalAmount: quote.totalAmount }, session);
      await createCustomerNotification({ recipient: repair.customer, type: "repair_quote_issued", title: "Repair quote ready", safePreview: "A repair quote is ready for your review.", resourceType: "repair", resourceId: repair._id, mandatory: true, eventKey: "repair-quote:" + quote._id, session });
    });
    return quote;
  } finally {
    await session.endSession();
  }
};

const decideQuote = async (repairId, quoteId, userId, userRole, decision, reason) => {
  if (!validId(quoteId)) throw unavailable();
  if (reason !== undefined && (typeof reason !== "string" || reason.trim().length > 500)) throw new AppError("Decline reason must be at most 500 characters", 400);
  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      const repair = await getDecisionRepair(repairId, userId, userRole, session);
      const now = new Date();
      const quote = await Quote.findOneAndUpdate(
        { _id: quoteId, repair: repair._id, status: { $in: QUOTE_ACTIONABLE_STATUSES }, isActionable: true, expiresAt: { $gt: now } },
        { $set: { status: decision, isActionable: false, decision: { type: decision, decidedAt: now, actor: userId, actorRole: userRole, reason: decision === QUOTE_STATUS.DECLINED && reason ? reason.trim() : null } } },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!quote) {
        const existing = await Quote.findOne({ _id: quoteId, repair: repair._id }).session(session);
        if (!existing) throw unavailable();
        if (existing.status === decision) { outcome = existing; return; }
        if (QUOTE_ACTIONABLE_STATUSES.includes(existing.status) && existing.expiresAt <= now) {
          await Quote.updateOne({ _id: existing._id, isActionable: true, expiresAt: { $lte: now } }, { $set: { status: QUOTE_STATUS.EXPIRED, isActionable: false } }, { session });
          await Repair.updateOne({ _id: repair._id }, { $set: { status: REPAIR_STATUS.QUOTE_PENDING } }, { session });
          throw conflict("quote_expired", "The quote has expired and can no longer be decided");
        }
        throw conflict("quote_not_actionable", "Only the latest actionable quote can be decided");
      }
      const accepted = decision === QUOTE_STATUS.ACCEPTED;
      await Repair.updateOne({ _id: repair._id }, {
        $set: accepted ? {
          status: REPAIR_STATUS.APPROVED,
          "financial.acceptedQuote": { quoteId: quote._id, version: quote.version, totalAmount: quote.totalAmount, currency: "NGN", acceptedAt: now },
          "financial.acceptedQuoteTotal": quote.totalAmount,
          "financial.outstandingBalance": quote.totalAmount,
          "financial.lastGateEvaluatedAt": now,
        } : { status: REPAIR_STATUS.DECLINED, "financial.refundCancellationState": "CANCELLATION_REQUESTED", "financial.lastGateEvaluatedAt": now },
      }, { session, runValidators: true });
      await writeAuditLog(userId, `QUOTE_${decision}`, "Quote", quote._id, { repairId: repairId.toString(), version: quote.version, totalAmount: quote.totalAmount }, session);
      outcome = quote;
    });
    return outcome;
  } finally {
    await session.endSession();
  }
};

export const approveQuote = (repairId, quoteId, userId, userRole) => decideQuote(repairId, quoteId, userId, userRole, QUOTE_STATUS.ACCEPTED);
export const declineQuote = (repairId, quoteId, userId, userRole, reason) => decideQuote(repairId, quoteId, userId, userRole, QUOTE_STATUS.DECLINED, reason);

export const expireOverdueQuotes = async (now = new Date()) => {
  const session = await mongoose.startSession();
  try {
    let expiredCount = 0;
    await session.withTransaction(async () => {
      const expired = await Quote.find({ isActionable: true, status: { $in: QUOTE_ACTIONABLE_STATUSES }, expiresAt: { $lte: now } }).select("_id repair").session(session);
      if (!expired.length) return;
      const result = await Quote.updateMany({ _id: { $in: expired.map((quote) => quote._id) }, isActionable: true, expiresAt: { $lte: now } }, { $set: { status: QUOTE_STATUS.EXPIRED, isActionable: false } }, { session });
      expiredCount = result.modifiedCount;
      await Repair.updateMany({ _id: { $in: expired.map((quote) => quote.repair) }, status: REPAIR_STATUS.QUOTE_SENT }, { $set: { status: REPAIR_STATUS.QUOTE_PENDING } }, { session });
    });
    return { expiredCount };
  } finally {
    await session.endSession();
  }
};

export const transitionToInRepair = async (repairId, actorId, actorRole) => {
  if (!validId(repairId) || !validId(actorId)) throw unavailable();
  if (![USER_ROLES.TECHNICIAN, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN].includes(actorRole)) throw new AppError("You do not have permission to start a repair", 403);
  const session = await mongoose.startSession();
  try {
    let repair;
    await session.withTransaction(async () => {
      const acceptedQuote = await Quote.findOne({ repair: repairId, status: QUOTE_STATUS.ACCEPTED }).session(session);
      if (!acceptedQuote) throw conflict("repair_quote_gate", "An accepted current quote is required before repair work can start");
      repair = await Repair.findOne({ _id: repairId, status: REPAIR_STATUS.APPROVED }).session(session);
      if (!repair) throw conflict("repair_quote_gate", "An accepted current quote is required before repair work can start");
      await assertRepairFinanceGate(repair, "WORK_START", session);
      repair.status = REPAIR_STATUS.IN_REPAIR;
      await repair.save({ session });
    });
    return repair;
  } finally {
    await session.endSession();
  }
};
