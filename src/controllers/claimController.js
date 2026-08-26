import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Warranty from "../models/Warranty.js";
import Claim from "../models/Claim.js";
import { CLAIM_STATUS } from "../utils/constants.js";
import { writeAuditLog } from "../services/auditService.js";

/**
 * Transition table for claim status
 */
const CLAIM_TRANSITIONS = {
  [CLAIM_STATUS.SUBMITTED]: [CLAIM_STATUS.SCREENING, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.SCREENING]: [CLAIM_STATUS.INSPECTION_REQUIRED, CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.INSPECTION_REQUIRED]: [CLAIM_STATUS.UNDER_INSPECTION, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.UNDER_INSPECTION]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.APPROVED]: [CLAIM_STATUS.REMEDY_IN_PROGRESS, CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REMEDY_IN_PROGRESS]: [CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REJECTED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.RESOLVED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.CLOSED]: [],
  [CLAIM_STATUS.CANCELLED]: []
};

const isValidTransition = (current, next) => {
  return CLAIM_TRANSITIONS[current]?.includes(next);
};

export const createClaim = catchAsync(async (req, res, next) => {
  const warrantyId = req.params.id;
  const { description } = req.body;

  const warranty = await Warranty.findOne({ _id: warrantyId, customer: req.user.id });

  if (!warranty) {
    return next(new AppError("Warranty not found", 404));
  }

  // Check expiration
  if (warranty.expiresAt < new Date()) {
    return next(new AppError("Warranty has already expired", 400));
  }

  const claim = await Claim.create({
    warranty: warrantyId,
    repair: warranty.repair,
    submittedBy: req.user.id,
    description,
    status: CLAIM_STATUS.SUBMITTED
  });
  await writeAuditLog(req.user.id, "CLAIM_SUBMITTED", "Claim", claim._id, { status: claim.status });

  res.status(201).json({
    success: true,
    data: claim
  });
});

export const updateClaimStatus = catchAsync(async (req, res, next) => {
  const { status, resolutionNotes } = req.body;
  const claim = await Claim.findById(req.params.id);

  if (!claim) {
    return next(new AppError("Claim not found", 404));
  }

  if (!isValidTransition(claim.status, status)) {
    return next(new AppError(`Invalid status transition from ${claim.status} to ${status}`, 400));
  }

  const oldStatus = claim.status;
  claim.status = status;
  if (resolutionNotes) claim.resolutionNotes = resolutionNotes;
  await claim.save();

  // Audit log
  await writeAuditLog(
    req.user.id,
    'UPDATE_CLAIM_STATUS',
    'Claim',
    claim._id,
    { oldStatus, newStatus: status }
  );

  res.status(200).json({
    success: true,
    data: claim
  });
});

export const getMyClaims = catchAsync(async (req, res) => {
  const claims = await Claim.find({ submittedBy: req.user.id })
    .populate('warranty')
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    data: claims
  });
});
