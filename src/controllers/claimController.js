import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Claim from "../models/Claim.js";
import { CLAIM_STATUS } from "../utils/constants.js";
import { createCustomerClaim, getClaim, listClaims } from "../services/warrantyCustomerService.js";
import { createCustomerNotification } from "../services/notificationService.js";
import { unavailable, conflict } from "../services/customerDomainService.js";
import { writeAuditLog } from "../services/auditService.js";

const claimTransitions = {
  [CLAIM_STATUS.SUBMITTED]: [CLAIM_STATUS.SCREENING, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.SCREENING]: [CLAIM_STATUS.INSPECTION_REQUIRED, CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.INSPECTION_REQUIRED]: [CLAIM_STATUS.UNDER_INSPECTION, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.UNDER_INSPECTION]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.APPROVED]: [CLAIM_STATUS.REMEDY_IN_PROGRESS, CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REMEDY_IN_PROGRESS]: [CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REJECTED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.RESOLVED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.CLOSED]: [],
  [CLAIM_STATUS.CANCELLED]: [],
};

const terminalStatuses = new Set([CLAIM_STATUS.REJECTED, CLAIM_STATUS.RESOLVED, CLAIM_STATUS.CLOSED, CLAIM_STATUS.CANCELLED]);

export const createClaim = catchAsync(async (req, res) => {
  const claim = await createCustomerClaim({
    owner: req.user.id,
    warrantyId: req.params.id,
    description: req.body.description,
    idempotencyKey: req.get("Idempotency-Key"),
  });
  res.status(201).json({ success: true, data: claim });
});

export const getMyClaims = catchAsync(async (req, res) => {
  res.json({ success: true, data: await listClaims({ owner: req.user.id, query: req.query }) });
});

export const getClaimDetail = catchAsync(async (req, res) => {
  res.json({ success: true, data: await getClaim({ owner: req.user.id, id: req.params.id }) });
});

export const updateClaimStatus = catchAsync(async (req, res) => {
  const { status, customerSafeReason, nextAction, informationRequests, remedy } = req.body;
  const currentClaim = await Claim.findById(req.params.id);
  if (!currentClaim) throw unavailable("Claim");

  const allowedNext = claimTransitions[currentClaim.status];
  if (!allowedNext || !allowedNext.includes(status)) {
    throw conflict("claim_transition_invalid", `Claim in status '${currentClaim.status}' cannot transition to '${status}'`);
  }

  const updates = {
    status,
    active: !terminalStatuses.has(status),
  };

  if (typeof customerSafeReason === "string") {
    updates.customerSafeReason = customerSafeReason.trim().slice(0, 1000);
  }
  if (typeof nextAction === "string") {
    updates.nextAction = nextAction.trim().slice(0, 500);
  }
  if (Array.isArray(informationRequests)) {
    updates.informationRequests = informationRequests.slice(0, 10).flatMap((item) =>
      typeof item?.message === "string" ? [{ message: item.message.trim().slice(0, 1000), dueAt: item.dueAt ? new Date(item.dueAt) : null }] : []
    );
  }
  if (remedy && ["repair", "replacement", "refund", "store_credit"].includes(remedy.type) && typeof remedy.summary === "string") {
    updates.remedy = {
      type: remedy.type,
      summary: remedy.summary.trim().slice(0, 1500),
      outcome: typeof remedy.outcome === "string" ? remedy.outcome.trim().slice(0, 1500) : null,
    };
  }

  const updatedClaim = await Claim.findOneAndUpdate(
    { _id: req.params.id, status: currentClaim.status },
    {
      $set: updates,
      $push: { customerSafeTimeline: { status, at: new Date(), message: updates.nextAction || null } },
    },
    { returnDocument: "after" }
  );

  if (!updatedClaim) {
    throw conflict("claim_transition_conflict", "Claim status was concurrently modified");
  }

  await createCustomerNotification({
    recipient: updatedClaim.submittedBy,
    type: "claim_status_updated",
    title: "Claim status updated",
    safePreview: "Your warranty claim has been updated.",
    resourceType: "claim",
    resourceId: updatedClaim._id,
    mandatory: true,
    eventKey: `claim-status:${updatedClaim._id}:${updatedClaim.updatedAt.getTime()}`,
  });

  await writeAuditLog(req.user.id, "CLAIM_STATUS_UPDATED", "Claim", updatedClaim._id, { status });

  res.json({ success: true, data: await getClaim({ owner: updatedClaim.submittedBy.toString(), id: updatedClaim._id.toString() }) });
});
