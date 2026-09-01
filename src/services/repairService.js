import Repair from "../models/Repair.js";
import Warranty from "../models/Warranty.js";
import Quote from "../models/Quote.js";
import Payment from "../models/Payment.js";
import AppError from "../utils/AppError.js";
import { REPAIR_STATUS, WARRANTY_PERIOD_DAYS, QUOTE_STATUS } from "../utils/constants.js";
import mongoose from "mongoose";
import { writeAuditLog } from "./auditService.js";
import { authorizeScopedTrackingToken, createTrackingToken, isObjectId, rotateTrackingToken, trackingUnavailable } from "./repairTrackingService.js";
import { assertRepairFinanceGate } from "./repairFinanceService.js";

const NEXT_ACTION_BY_STATUS = Object.freeze({
  [REPAIR_STATUS.REQUESTED]: "We will review your repair request.",
  [REPAIR_STATUS.INTAKE_PENDING]: "Please arrange device intake with our team.",
  [REPAIR_STATUS.INTAKE_SCHEDULED]: "Bring your device at the scheduled intake time.",
  [REPAIR_STATUS.RECEIVED]: "Your device has been received for intake.",
  [REPAIR_STATUS.IN_CUSTODY]: "Your device is securely in our custody.",
  [REPAIR_STATUS.DIAGNOSING]: "Our technician is diagnosing the device.",
  [REPAIR_STATUS.QUOTE_PENDING]: "We are preparing an updated quote.",
  [REPAIR_STATUS.QUOTE_SENT]: "Review the latest quote and accept or decline it.",
  [REPAIR_STATUS.AWAITING_APPROVAL]: "Review the latest quote and accept or decline it.",
  [REPAIR_STATUS.APPROVED]: "We are preparing to begin the approved repair.",
  [REPAIR_STATUS.AWAITING_PARTS]: "We are arranging the parts needed for your repair.",
  [REPAIR_STATUS.IN_REPAIR]: "Your repair is in progress.",
  [REPAIR_STATUS.PAUSED]: "Your repair is temporarily paused while we review the next step.",
  [REPAIR_STATUS.QC_PENDING]: "Your repair is awaiting quality checks.",
  [REPAIR_STATUS.QC]: "Your repair is undergoing quality checks.",
  [REPAIR_STATUS.READY]: "Your repair is ready for handover.",
  [REPAIR_STATUS.READY_FOR_PICKUP]: "Your repair is ready for pickup.",
  [REPAIR_STATUS.HANDED_OVER]: "Your repaired device has been handed over.",
  [REPAIR_STATUS.COMPLETED]: "This repair is complete.",
  [REPAIR_STATUS.DECLINED]: "The quote was declined; contact us if you would like to discuss next steps.",
  [REPAIR_STATUS.CANCELLED]: "This repair has been cancelled; contact us for assistance.",
});

export const publicNextAction = (status) => NEXT_ACTION_BY_STATUS[status] || "Contact support for the current repair status.";

export const createRepairWithTrackingToken = async ({ customerId, device, issueDescription, privacyAcknowledged }) => {
  if (!isObjectId(customerId)) throw new AppError("Authentication required", 401);
  const session = await mongoose.startSession();
  try {
    let repair;
    let trackingToken;
    await session.withTransaction(async () => {
      repair = (await Repair.create([{ customer: customerId, device, issueDescription, privacyAcknowledged }], { session }))[0];
      trackingToken = await createTrackingToken(repair._id, { session });
    });
    return { repair, trackingToken };
  } finally {
    await session.endSession();
  }
};

export const rotateOwnerTrackingToken = async (repairId, actorId) => {
  if (!isObjectId(repairId) || !isObjectId(actorId)) throw trackingUnavailable();
  const session = await mongoose.startSession();
  try {
    let trackingToken;
    await session.withTransaction(async () => {
      const repair = await Repair.findOne({ _id: repairId, customer: actorId }).session(session);
      if (!repair) throw trackingUnavailable();
      trackingToken = await rotateTrackingToken(repair._id, actorId, session);
    });
    return trackingToken;
  } finally {
    await session.endSession();
  }
};

export const intakeRepair = async (repairId, { intakePhotos, intakeCondition }) => {
  if (!intakePhotos || intakePhotos.length === 0) {
    throw new AppError("Intake photos are required.", 400);
  }
  if (!intakeCondition) {
    throw new AppError("Intake condition description is required.", 400);
  }

  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  repair.intakePhotos = intakePhotos;
  repair.intakeCondition = intakeCondition;
  repair.status = REPAIR_STATUS.RECEIVED;

  await repair.save();
  return repair;
};

export const assignTechnician = async (repairId, technicianId) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  repair.technician = technicianId;
  // Status DIAGNOSING is NOT automatic on assignment per requirement.
  await repair.save();
  return repair;
};

export const recordDiagnosis = async (repairId, technicianId, { diagnosisNotes, estimatedCost }) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  // HARD GATE: req.user.id must equal repair.technician.toString()
  if (!repair.technician || repair.technician.toString() !== technicianId) {
    throw new AppError("You are not the assigned technician for this repair.", 403);
  }

  repair.diagnosisNotes = diagnosisNotes;
  repair.estimatedCost = estimatedCost;
  // Requirement: status -> QUOTE_SENT is NOT set here.
  
  await repair.save();
  return repair;
};

export const completeRepairWork = async (repairId, technicianId, { notes }) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  if (!repair.technician || repair.technician.toString() !== technicianId) {
    throw new AppError("You are not the assigned technician for this repair.", 403);
  }

  if (repair.status !== REPAIR_STATUS.IN_REPAIR) {
    throw new AppError("Only repairs in 'in_repair' status can be marked as complete.", 400);
  }

  repair.status = REPAIR_STATUS.QC;
  repair.workLog.push({ 
    note: `Work completed by technician. Transitioned to QC. ${notes || ''}`, 
    author: technicianId 
  });

  await repair.save();
  return repair;
};

export const addWorkLogEntry = async (repairId, authorId, note) => {
  const repair = await Repair.findByIdAndUpdate(
    repairId,
    { 
      $push: { 
        workLog: { note, author: authorId } 
      } 
    },
    { returnDocument: 'after', runValidators: true }
  ).populate("workLog.author", "name role");

  return repair;
};

export const performQC = async (repairId, qcOfficerId, qcRole, { passed, note, checklistVersion, results, evidenceIds = [], failureReasons = [] }) => {
  if (!["qc_officer", "super_admin"].includes(qcRole)) throw new AppError("You do not have permission to perform quality control", 403);
  if (passed && (!checklistVersion || !results || !Array.isArray(evidenceIds) || evidenceIds.length === 0)) {
    throw new AppError("A passed quality-control record requires checklist results and evidence", 409, [{ code: "qc_evidence_gate", message: "Complete the QC checklist and attach required evidence" }]);
  }
  const session = await mongoose.startSession();
  try {
    let repair;
    await session.withTransaction(async () => {
      repair = await Repair.findById(repairId).session(session);
      if (!repair) throw new AppError("Repair not found.", 404);
      // A technician who completed the work cannot self-approve QC.
      if (repair.technician && repair.technician.toString() === qcOfficerId) throw new AppError("Technicians cannot QC their own work.", 403);
      if (passed) await assertRepairFinanceGate(repair, "QC", session);
      repair.qcRecord = {
        checklistVersion: checklistVersion || null,
        results: results || null,
        passed: Boolean(passed),
        officer: qcOfficerId,
        performedAt: new Date(),
        evidenceIds,
        failureReasons: Array.isArray(failureReasons) ? failureReasons.slice(0, 20) : [],
      };
      repair.status = passed ? REPAIR_STATUS.READY : REPAIR_STATUS.IN_REPAIR;
      await repair.save({ session });
      await writeAuditLog(qcOfficerId, passed ? "QC_PASSED" : "QC_FAILED", "Repair", repair._id, { note: typeof note === "string" ? note.slice(0, 500) : undefined }, session);
    });
    return repair;
  } finally {
    await session.endSession();
  }
};

export const handoverRepair = async (repairId, actorId, actorRole, handover = {}) => {
  if (!["store_operator", "ops_manager", "super_admin"].includes(actorRole)) throw new AppError("You do not have permission to hand over repairs", 403);
  const session = await mongoose.startSession();
  try {
    let repair;
    let warranty;
    await session.withTransaction(async () => {
      repair = await Repair.findById(repairId).session(session);
      if (!repair) throw new AppError("Repair not found.", 404);
      if (repair.status !== REPAIR_STATUS.READY || !repair.qcRecord?.passed) throw new AppError("Repair must be in READY status for handover.", 400);
      await assertRepairFinanceGate(repair, "HANDOVER", session);
      if (!handover.recipient || !handover.identityVerificationMethod || !handover.customerAcknowledgement) {
        throw new AppError("Repair handover evidence is incomplete", 409, [{ code: "repair_handover_evidence_gate", message: "Recipient identity verification and acknowledgement are required" }]);
      }
      repair.status = REPAIR_STATUS.HANDED_OVER;
      await repair.save({ session });
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + WARRANTY_PERIOD_DAYS);
      const deviceSummary = `${repair.device.brand} ${repair.device.model} (${repair.device.type})`;
      [warranty] = await Warranty.create([{ repair: repair._id, customer: repair.customer, deviceSummary, expiresAt }], { session });
      await writeAuditLog(actorId, "REPAIR_HANDED_OVER", "Repair", repair._id, { financeGate: "passed", qcGate: "passed" }, session);
    });
    return { repair, warranty };
  } finally {
    await session.endSession();
  }
};

const repairPaymentProjection = async (repair, quote) => {
  const required = Number.isSafeInteger(repair.financial?.requiredDepositAmount) ? repair.financial.requiredDepositAmount : 0;
  const currency = repair.financial?.depositCurrency || "NGN";
  if (required <= 0) return { depositRequirement: { required: false, amount: 0, currency, dueBeforeWork: false }, paymentState: { status: "not_required", confirmedAmount: 0, remainingAmount: 0 } };
  const payments = await Payment.find({ subjectType: "repair", subjectId: repair._id, owner: repair.customer, quoteVersion: quote.version }).select("status netPaidAmount capturedAmount").lean();
  const confirmedAmount = payments.filter((payment) => ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(payment.status)).reduce((sum, payment) => sum + Math.max(0, payment.netPaidAmount || payment.capturedAmount || 0), 0);
  const anyFailed = payments.some((payment) => payment.status === "FAILED" || payment.status === "CANCELLED");
  const status = confirmedAmount >= required ? "confirmed" : confirmedAmount > 0 ? "partially_confirmed" : anyFailed ? "failed" : "pending";
  return { depositRequirement: { required: true, amount: required, currency, dueBeforeWork: true }, paymentState: { status, confirmedAmount, remainingAmount: Math.max(0, required - confirmedAmount) } };
};

export const toPublicRepair = async (repair) => {
  const quote = await Quote.findOne({ repair: repair._id, status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.VIEWED, QUOTE_STATUS.ACCEPTED, QUOTE_STATUS.DECLINED, QUOTE_STATUS.EXPIRED, QUOTE_STATUS.SUPERSEDED] } }).sort({ version: -1 }).lean();
  const supersededBy = quote?.status === QUOTE_STATUS.SUPERSEDED ? await Quote.findOne({ repair: repair._id, version: { $gt: quote.version }, status: { $ne: QUOTE_STATUS.DRAFT } }).sort({ version: 1 }).select("version").lean() : null;
  const projectedQuoteStatus = quote && quote.expiresAt && quote.expiresAt <= new Date() && ["SENT", "VIEWED"].includes(quote.status) ? QUOTE_STATUS.EXPIRED : quote?.status;
  const financial = quote ? await repairPaymentProjection(repair, quote) : null;
  return { id: repair._id.toString(), status: repair.status, nextAction: publicNextAction(repair.status), updatedAt: repair.updatedAt, quote: quote ? { id: quote._id.toString(), version: quote.version, lineItems: quote.lineItems.map(({ description, amount }) => ({ description, amount })), totalAmount: quote.totalAmount, estimatedDays: quote.estimatedDays, status: projectedQuoteStatus, issuedAt: quote.createdAt, expiresAt: quote.expiresAt, superseded: quote.status === QUOTE_STATUS.SUPERSEDED || (!quote.isActionable && quote.status !== QUOTE_STATUS.ACCEPTED && quote.status !== QUOTE_STATUS.DECLINED), supersededByVersion: supersededBy?.version || null, ...financial } : null };
};

export const getRepairStatus = async (repairId, actor, rawTrackingToken) => {
  if (!isObjectId(repairId)) throw trackingUnavailable();
  const repair = await Repair.findById(repairId);
  if (!repair) throw trackingUnavailable();
  const ownerAuthorized = actor && isObjectId(actor.id) && repair.customer.toString() === actor.id;
  if (!ownerAuthorized) await authorizeScopedTrackingToken(repair._id, rawTrackingToken);
  return toPublicRepair(repair);
};

export const findUsersByEmailOrName = async (searchRegex) => {
  return mongoose.model('User').find({
    $or: [
      { name: searchRegex },
      { email: searchRegex }
    ]
  }).select('_id');
};
