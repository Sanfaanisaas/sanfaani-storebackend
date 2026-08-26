import ReturnRequest from "../models/ReturnRequest.js";
import Order from "../models/Order.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "../services/auditService.js";

export const createReturn = catchAsync(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.orderId, userId: req.user.id });
  if (!order) throw new AppError("Order is unavailable", 404);
  const { items, reason, evidenceIds = [] } = req.body;
  if (!Array.isArray(items) || !items.length || items.length > 50 || typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) throw new AppError("Return input is invalid", 400);
  for (const item of items) if (!item || !order.items.some((orderItem) => orderItem.variantSku === item.variantSku) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new AppError("Return item is unavailable", 400);
  const request = await ReturnRequest.create({ order: order._id, owner: req.user.id, items, reason: reason.trim(), evidenceIds: Array.isArray(evidenceIds) ? evidenceIds.slice(0, 20) : [] });
  await writeAuditLog(req.user.id, "RETURN_SUBMITTED", "ReturnRequest", request._id, { status: request.status });
  res.status(201).json({ success: true, data: request });
});
export const listMyReturns = catchAsync(async (req, res) => res.json({ success: true, data: await ReturnRequest.find({ owner: req.user.id }).sort({ updatedAt: -1 }).lean() }));
export const decideReturn = catchAsync(async (req, res) => {
  const { status, remedy, privateNotes } = req.body;
  if (!["APPROVED", "REJECTED", "INSPECTION_REQUIRED"].includes(status) || (remedy && !["repair", "replacement", "refund", "store_credit"].includes(remedy))) throw new AppError("Return transition is invalid", 400);
  const request = await ReturnRequest.findOneAndUpdate({ _id: req.params.id, status: { $in: ["SUBMITTED", "UNDER_INSPECTION", "INSPECTION_REQUIRED"] } }, { $set: { status, remedy: remedy || null, privateNotes: typeof privateNotes === "string" ? privateNotes.slice(0, 2000) : null } }, { returnDocument: "after", runValidators: true });
  if (!request) throw new AppError("Return request is unavailable", 409);
  await writeAuditLog(req.user.id, "RETURN_DECIDED", "ReturnRequest", request._id, { status: request.status, remedy: request.remedy });
  res.json({ success: true, data: request });
});
