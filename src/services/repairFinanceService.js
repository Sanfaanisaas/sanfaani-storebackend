import mongoose from "mongoose";
import Repair from "../models/Repair.js";
import RepairFinanceOverride, { FINANCE_OVERRIDE_SCOPES } from "../models/RepairFinanceOverride.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "./auditService.js";

export const FINANCE_GATE_STAGES = Object.freeze(["WORK_START", "QC", "READY", "HANDOVER"]);
const FINANCE_ROLES = new Set(["finance_officer", "ops_manager", "super_admin"]);

const conflict = (code, message) => new AppError(message, 409, [{ code, message }]);
const unavailable = () => new AppError("Repair finance information is unavailable", 404, [{ code: "repair_finance_unavailable", message: "Check the repair reference and permissions" }]);
const validId = (value) => mongoose.isObjectIdOrHexString(value);
const boundedReason = (value) => {
  if (typeof value !== "string" || value.trim().length < 3 || value.trim().length > 500) {
    throw new AppError("A bounded finance reason is required", 400, [{ code: "finance_reason_invalid", message: "Provide a reason between 3 and 500 characters" }]);
  }
  return value.trim();
};

const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const baseState = (repair) => {
  const financial = repair.financial || {};
  const acceptedQuoteTotal = number(financial.acceptedQuote?.totalAmount ?? financial.acceptedQuoteTotal);
  const requiredDeposit = number(financial.requiredDepositAmount);
  const verifiedPaid = number(financial.confirmedPaidAmount);
  const verifiedRefunded = number(financial.refundedAmount);
  const netPaid = Math.max(0, number(financial.netPaidAmount));
  const outstandingBalance = Math.max(0, acceptedQuoteTotal - netPaid);
  const financeGateState = netPaid < requiredDeposit
    ? "DEPOSIT_REQUIRED"
    : outstandingBalance > 0
      ? "OUTSTANDING"
      : "CLEAR";
  return { financeGateState, acceptedQuoteTotal, requiredDeposit, verifiedPaid, verifiedRefunded, netPaid, outstandingBalance };
};

const activeOverride = (repairId, stage, session) => RepairFinanceOverride.findOne({
  repair: repairId,
  status: "ACTIVE",
  scope: { $in: ["ALL", stage] },
}).sort({ scope: 1, createdAt: -1 }).session(session);

/**
 * Derive the persisted gate from payment/refund-derived financial fields. An
 * active, audited override can clear only its declared stage; it never changes
 * provider history or the underlying monetary totals.
 */
export const evaluateRepairFinanceGate = async (repair, { stage = null, session, persist = true } = {}) => {
  const state = baseState(repair);
  const override = stage
    ? await activeOverride(repair._id, stage, session)
    : await RepairFinanceOverride.findOne({ repair: repair._id, status: "ACTIVE", scope: "ALL" }).session(session);
  const effectiveState = override ? { ...state, financeGateState: "OVERRIDDEN" } : state;
  repair.financial.acceptedQuoteTotal = state.acceptedQuoteTotal;
  repair.financial.outstandingBalance = state.outstandingBalance;
  repair.financial.financeGateState = effectiveState.financeGateState;
  repair.financial.financeGateEvaluatedAt = new Date();
  repair.financial.lastGateEvaluatedAt = repair.financial.financeGateEvaluatedAt;
  if (persist) await repair.save({ session });
  return { state: effectiveState, override };
};

export const assertRepairFinanceGate = async (repair, stage, session) => {
  if (!FINANCE_GATE_STAGES.includes(stage)) throw new Error(`Unknown finance gate stage: ${stage}`);
  const { state, override } = await evaluateRepairFinanceGate(repair, { stage, session, persist: false });
  if (override) return { state, override };
  if (stage === "WORK_START" && state.netPaid >= state.requiredDeposit) return { state, override: null };
  if (["QC", "READY", "HANDOVER"].includes(stage) && state.outstandingBalance === 0) return { state, override: null };
  const code = stage === "WORK_START" ? "repair_deposit_gate" : "repair_finance_gate";
  const message = stage === "WORK_START"
    ? "Verified required deposit is needed before repair work can start"
    : "Verified outstanding-balance clearance is required before this repair stage";
  throw conflict(code, message);
};

const runTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
};

export const createRepairFinanceOverride = async ({ repairId, actorId, actorRole, scope = "ALL", reason }) => {
  if (!FINANCE_ROLES.has(actorRole)) throw new AppError("You do not have permission to override repair finance gates", 403);
  if (!validId(repairId) || !validId(actorId)) throw unavailable();
  if (!FINANCE_OVERRIDE_SCOPES.includes(scope)) throw new AppError("Finance override scope is invalid", 400);
  const normalizedReason = boundedReason(reason);
  return runTransaction(async (session) => {
    const repair = await Repair.findOne({ _id: { $eq: repairId } }).session(session);
    if (!repair) throw unavailable();
    const beforeState = baseState(repair);
    const superseded = await RepairFinanceOverride.findOneAndUpdate(
      { repair: repair._id, scope, status: "ACTIVE" },
      { $set: { status: "SUPERSEDED" } },
      { returnDocument: "after", session },
    );
    const afterState = { ...beforeState, financeGateState: "OVERRIDDEN" };
    const [override] = await RepairFinanceOverride.create([{
      repair: repair._id, scope, reason: normalizedReason, beforeState, afterState, createdBy: actorId,
    }], { session });
    if (superseded) {
      superseded.supersededBy = override._id;
      await superseded.save({ session });
    }
    repair.financial.financeGateState = "OVERRIDDEN";
    repair.financial.financeGateEvaluatedAt = new Date();
    repair.financial.lastGateEvaluatedAt = repair.financial.financeGateEvaluatedAt;
    await repair.save({ session });
    await writeAuditLog(actorId, "REPAIR_FINANCE_OVERRIDE_CREATED", "RepairFinanceOverride", override._id, { repairId: repair._id.toString(), scope, beforeState: beforeState.financeGateState, afterState: "OVERRIDDEN" }, session);
    return override;
  });
};

export const revokeRepairFinanceOverride = async ({ overrideId, actorId, actorRole, reason }) => {
  if (!FINANCE_ROLES.has(actorRole)) throw new AppError("You do not have permission to revoke repair finance overrides", 403);
  if (!validId(overrideId) || !validId(actorId)) throw unavailable();
  const normalizedReason = boundedReason(reason);
  return runTransaction(async (session) => {
    const override = await RepairFinanceOverride.findOne({ _id: overrideId, status: "ACTIVE" }).session(session);
    if (!override) throw conflict("repair_finance_override_unavailable", "The finance override is unavailable");
    const repair = await Repair.findById(override.repair).session(session);
    if (!repair) throw unavailable();
    override.status = "REVOKED";
    override.revokedBy = actorId;
    override.revokedAt = new Date();
    override.revocationReason = normalizedReason;
    await override.save({ session });
    await evaluateRepairFinanceGate(repair, { session, persist: true });
    await writeAuditLog(actorId, "REPAIR_FINANCE_OVERRIDE_REVOKED", "RepairFinanceOverride", override._id, { repairId: repair._id.toString(), scope: override.scope, reason: normalizedReason }, session);
    return override;
  });
};
