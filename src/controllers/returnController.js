import ReturnRequest from "../models/ReturnRequest.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { createCustomerReturn, getReturn, listReturns, returnEligibility } from "../services/warrantyCustomerService.js";
import { createCustomerNotification } from "../services/notificationService.js";
import { conflict, fingerprint, requireIdempotencyKey, unavailable } from "../services/customerDomainService.js";
import { writeAuditLog } from "../services/auditService.js";

const returnTransitions = {
  SUBMITTED: ["INSPECTION_REQUIRED", "UNDER_INSPECTION", "APPROVED", "REJECTED", "CANCELLED"],
  INSPECTION_REQUIRED: ["UNDER_INSPECTION", "CANCELLED"],
  UNDER_INSPECTION: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["REMEDY_IN_PROGRESS", "RESOLVED"],
  REMEDY_IN_PROGRESS: ["RESOLVED"],
  REJECTED: ["CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};

export const getReturnEligibility = catchAsync(async (req, res) => {
  res.json({ success: true, data: await returnEligibility({ owner: req.user.id, orderId: req.params.orderId }) });
});

export const createReturn = catchAsync(async (req, res) => {
  const key = requireIdempotencyKey(req.get("Idempotency-Key"));
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (!items.length || reason.length < 3 || reason.length > 500) {
    throw new AppError("Return input is invalid", 400, [{ code: "return_input_invalid", message: "Select items and provide a reason between 3 and 500 characters" }]);
  }
  const request = await createCustomerReturn({
    owner: req.user.id,
    orderId: req.params.orderId,
    items,
    reason,
    idempotencyKey: key,
    fingerprint: fingerprint({ orderId: req.params.orderId, items, reason }),
  });
  res.status(201).json({ success: true, data: request });
});

export const listMyReturns = catchAsync(async (req, res) => {
  res.json({ success: true, data: await listReturns({ owner: req.user.id, query: req.query }) });
});

export const getReturnDetail = catchAsync(async (req, res) => {
  res.json({ success: true, data: await getReturn({ owner: req.user.id, id: req.params.id }) });
});

export const decideReturn = catchAsync(async (req, res) => {
  const { status, remedy, privateNotes, nextAction, acceptedQuantities } = req.body;
  const currentRequest = await ReturnRequest.findById(req.params.id);
  if (!currentRequest) throw unavailable("Return request");

  const allowedNext = returnTransitions[currentRequest.status];
  if (!allowedNext || !allowedNext.includes(status)) {
    throw conflict("return_transition_invalid", `Return request in status '${currentRequest.status}' cannot transition to '${status}'`);
  }

  if (remedy && !["repair", "replacement", "refund", "store_credit"].includes(remedy)) {
    throw new AppError("Invalid return remedy", 400, [{ code: "return_remedy_invalid", message: "Choose a valid return remedy" }]);
  }

  const updates = {
    status,
    remedy: remedy || currentRequest.remedy || null,
    privateNotes: typeof privateNotes === "string" ? privateNotes.slice(0, 2000) : currentRequest.privateNotes,
    nextAction: typeof nextAction === "string" ? nextAction.slice(0, 500) : currentRequest.nextAction,
  };

  if (acceptedQuantities && typeof acceptedQuantities === "object") {
    for (const item of currentRequest.items) {
      if (acceptedQuantities[item.variantSku] !== undefined) {
        const qty = Number(acceptedQuantities[item.variantSku]);
        if (Number.isSafeInteger(qty) && qty >= 0 && qty <= item.quantity) {
          item.acceptedQuantity = qty;
        }
      }
    }
    updates.items = currentRequest.items;
  }

  const updatedRequest = await ReturnRequest.findOneAndUpdate(
    { _id: req.params.id, status: currentRequest.status },
    {
      $set: updates,
      $push: { customerSafeTimeline: { status, at: new Date(), message: updates.nextAction || null } },
    },
    { returnDocument: "after" }
  );

  if (!updatedRequest) {
    throw conflict("return_transition_conflict", "Return request status was concurrently modified");
  }

  await createCustomerNotification({
    recipient: updatedRequest.owner,
    type: "return_status_updated",
    title: "Return status updated",
    safePreview: "Your return request has been updated.",
    resourceType: "return",
    resourceId: updatedRequest._id,
    mandatory: true,
    eventKey: `return-status:${updatedRequest._id}:${updatedRequest.updatedAt.getTime()}`,
  });

  await writeAuditLog(req.user.id, "RETURN_DECIDED", "ReturnRequest", updatedRequest._id, { status: updatedRequest.status, remedy: updatedRequest.remedy });

  res.json({ success: true, data: await getReturn({ owner: updatedRequest.owner.toString(), id: updatedRequest._id.toString() }) });
});
