import Repair from "../models/Repair.js";
import Warranty from "../models/Warranty.js";
import Quote from "../models/Quote.js";
import AppError from "../utils/AppError.js";
import { REPAIR_STATUS, WARRANTY_PERIOD_DAYS, QUOTE_STATUS } from "../utils/constants.js";
import mongoose from "mongoose";

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

export const performQC = async (repairId, qcOfficerId, { passed, note }) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  // HARD GATE: A technician who also happens to hold qc_officer cannot QC their own repair.
  if (repair.technician && repair.technician.toString() === qcOfficerId) {
    throw new AppError("Technicians cannot QC their own work.", 403);
  }

  if (passed) {
    repair.status = REPAIR_STATUS.READY;
  } else {
    repair.status = REPAIR_STATUS.IN_REPAIR;
  }

  if (note) {
    repair.workLog.push({ note: `QC ${passed ? 'PASSED' : 'FAILED'}: ${note}`, author: qcOfficerId });
  } else if (!passed) {
     throw new AppError("Work log entry explaining why is required for QC failure.", 400);
  } else {
    repair.workLog.push({ note: `QC PASSED`, author: qcOfficerId });
  }

  await repair.save();
  return repair;
};

export const handoverRepair = async (repairId) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const repair = await Repair.findById(repairId).session(session);
    if (!repair) {
      throw new AppError("Repair not found.", 404);
    }

    if (repair.status !== REPAIR_STATUS.READY) {
      throw new AppError("Repair must be in READY status for handover.", 400);
    }

    repair.status = REPAIR_STATUS.HANDED_OVER;
    await repair.save({ session });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + WARRANTY_PERIOD_DAYS);

    const deviceSummary = `${repair.device.brand} ${repair.device.model} (${repair.device.type})`;

    const warranty = await Warranty.create([{
      repair: repair._id,
      customer: repair.customer,
      deviceSummary,
      expiresAt,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return { repair, warranty: warranty[0] };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export const toPublicRepair = async (repair) => {
  const acceptedQuote = await Quote.findOne({ 
    repair: repair._id, 
    status: QUOTE_STATUS.ACCEPTED 
  });

  return {
    id: repair._id,
    status: repair.status,
    device: {
      type: repair.device.type,
      brand: repair.device.brand,
      model: repair.device.model,
    },
    timeline: {
      createdAt: repair.createdAt,
      updatedAt: repair.updatedAt,
    },
    quoteTotal: acceptedQuote ? acceptedQuote.total : null,
  };
};

export const getRepairStatus = async (repairId) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }
  return toPublicRepair(repair);
};
