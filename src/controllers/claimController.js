import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Claim from "../models/Claim.js";
import { CLAIM_STATUS } from "../utils/constants.js";
import { createCustomerClaim, getClaim, listClaims } from "../services/warrantyCustomerService.js";
import { createCustomerNotification } from "../services/notificationService.js";
import { unavailable } from "../services/customerDomainService.js";
import { writeAuditLog } from "../services/auditService.js";

const transitions = {
  [CLAIM_STATUS.SUBMITTED]: [CLAIM_STATUS.SCREENING, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.SCREENING]: [CLAIM_STATUS.INSPECTION_REQUIRED, CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.INSPECTION_REQUIRED]: [CLAIM_STATUS.UNDER_INSPECTION, CLAIM_STATUS.CANCELLED],
  [CLAIM_STATUS.UNDER_INSPECTION]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.APPROVED]: [CLAIM_STATUS.REMEDY_IN_PROGRESS, CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REMEDY_IN_PROGRESS]: [CLAIM_STATUS.RESOLVED],
  [CLAIM_STATUS.REJECTED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.RESOLVED]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.CLOSED]: [], [CLAIM_STATUS.CANCELLED]: [],
};
const terminal = new Set([CLAIM_STATUS.REJECTED, CLAIM_STATUS.RESOLVED, CLAIM_STATUS.CLOSED, CLAIM_STATUS.CANCELLED]);

export const createClaim = catchAsync(async (req, res) => {
  const claim = await createCustomerClaim({ owner: req.user.id, warrantyId: req.params.id, description: req.body.description });
  res.status(201).json({ success: true, data: claim });
});
export const getMyClaims = catchAsync(async (req, res) => res.json({ success: true, data: await listClaims({ owner: req.user.id, query: req.query }) }));
export const getClaimDetail = catchAsync(async (req, res) => res.json({ success: true, data: await getClaim({ owner: req.user.id, id: req.params.id }) }));
export const updateClaimStatus = catchAsync(async (req, res) => {
  const { status, customerSafeReason, nextAction, informationRequests, remedy } = req.body;
  const claim = await Claim.findById(req.params.id).select("+resolutionNotes");
  if (!claim) throw unavailable("Claim");
  if (!Object.values(CLAIM_STATUS).includes(status) || !transitions[claim.status]?.includes(status)) throw new AppError("Claim transition is invalid", 409, [{ code: "claim_transition_invalid", message: "This claim cannot move to that status" }]);
  claim.status = status; claim.active = !terminal.has(status);
  claim.customerSafeReason = typeof customerSafeReason === "string" ? customerSafeReason.trim().slice(0, 1000) : claim.customerSafeReason;
  claim.nextAction = typeof nextAction === "string" ? nextAction.trim().slice(0, 500) : claim.nextAction;
  if (Array.isArray(informationRequests)) claim.informationRequests = informationRequests.slice(0, 10).flatMap((item) => typeof item?.message === "string" ? [{ message: item.message.trim().slice(0, 1000), dueAt: item.dueAt ? new Date(item.dueAt) : null }] : []);
  if (remedy && ["repair", "replacement", "refund", "store_credit"].includes(remedy.type) && typeof remedy.summary === "string") claim.remedy = { type: remedy.type, summary: remedy.summary.trim().slice(0, 1500), outcome: typeof remedy.outcome === "string" ? remedy.outcome.trim().slice(0, 1500) : null };
  claim.customerSafeTimeline.push({ status, at: new Date(), message: claim.nextAction || null });
  await claim.save();
  await createCustomerNotification({ recipient: claim.submittedBy, type: "claim_status_updated", title: "Claim status updated", safePreview: "Your warranty claim has been updated.", resourceType: "claim", resourceId: claim._id, mandatory: true, eventKey: `claim-status:${claim._id}:${claim.updatedAt.getTime()}` });
  await writeAuditLog(req.user.id, "CLAIM_STATUS_UPDATED", "Claim", claim._id, { status });
  res.json({ success: true, data: await getClaim({ owner: claim.submittedBy.toString(), id: claim._id.toString() }) });
});
