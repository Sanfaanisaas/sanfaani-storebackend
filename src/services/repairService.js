import Repair from "../models/Repair.js";
import AppError from "../utils/AppError.js";
import { REPAIR_STATUS } from "../utils/constants.js";

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
