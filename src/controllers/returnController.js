import ReturnRequest from "../models/ReturnRequest.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { createCustomerReturn, getReturn, listReturns, returnEligibility } from "../services/warrantyCustomerService.js";
import { createCustomerNotification } from "../services/notificationService.js";
import { fingerprint, requireIdempotencyKey, unavailable } from "../services/customerDomainService.js";
import { writeAuditLog } from "../services/auditService.js";

export const getReturnEligibility = catchAsync(async (req, res) => res.json({ success: true, data: await returnEligibility({ owner: req.user.id, orderId: req.params.orderId }) }));
export const createReturn = catchAsync(async (req, res) => {
  const key = requireIdempotencyKey(req.get("Idempotency-Key"));
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (!items.length || reason.length < 3 || reason.length > 500) throw new AppError("Return input is invalid", 400, [{ code: "return_input_invalid", message: "Select items and provide a reason between 3 and 500 characters" }]);
  const request = await createCustomerReturn({ owner: req.user.id, orderId: req.params.orderId, items, reason, idempotencyKey: key, fingerprint: fingerprint({ orderId: req.params.orderId, items, reason }) });
  res.status(201).json({ success: true, data: request });
});
export const listMyReturns = catchAsync(async (req, res) => res.json({ success: true, data: await listReturns({ owner: req.user.id, query: req.query }) }));
export const getReturnDetail = catchAsync(async (req, res) => res.json({ success: true, data: await getReturn({ owner: req.user.id, id: req.params.id }) }));
export const decideReturn = catchAsync(async (req, res) => {
  const { status, remedy, privateNotes, nextAction } = req.body;
  if (!["APPROVED", "REJECTED", "INSPECTION_REQUIRED", "UNDER_INSPECTION", "REMEDY_IN_PROGRESS", "RESOLVED", "CANCELLED"].includes(status) || (remedy && !["repair", "replacement", "refund", "store_credit"].includes(remedy))) throw new AppError("Return transition is invalid", 400);
  const request = await ReturnRequest.findOne({ _id: req.params.id, status: { $in: ["SUBMITTED", "UNDER_INSPECTION", "INSPECTION_REQUIRED", "APPROVED", "REMEDY_IN_PROGRESS"] } }).select("+privateNotes");
  if (!request) throw unavailable("Return request");
  request.status = status; request.remedy = remedy || request.remedy || null; request.privateNotes = typeof privateNotes === "string" ? privateNotes.slice(0, 2000) : request.privateNotes; request.nextAction = typeof nextAction === "string" ? nextAction.slice(0, 500) : request.nextAction;
  request.customerSafeTimeline.push({ status, at: new Date(), message: request.nextAction || null }); await request.save();
  await createCustomerNotification({ recipient: request.owner, type: "return_status_updated", title: "Return status updated", safePreview: "Your return request has been updated.", resourceType: "return", resourceId: request._id, mandatory: true, eventKey: `return-status:${request._id}:${request.updatedAt.getTime()}` });
  await writeAuditLog(req.user.id, "RETURN_DECIDED", "ReturnRequest", request._id, { status: request.status, remedy: request.remedy });
  res.json({ success: true, data: await getReturn({ owner: request.owner.toString(), id: request._id.toString() }) });
});
