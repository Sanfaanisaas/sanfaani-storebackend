import Payment from "../models/Payment.js";
import ReconciliationCase from "../models/ReconciliationCase.js";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { writeAuditLog } from "../services/auditService.js";
import { reserveRefund } from "../services/paymentTransitionService.js";
import { createRepairFinanceOverride, revokeRepairFinanceOverride } from "../services/repairFinanceService.js";

const notFound = () => new AppError("Payment information is unavailable", 404, [{ code: "payment_unavailable", message: "Check the payment reference and account" }]);

export const getPayment = catchAsync(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.paymentId, owner: req.user.id }).select("_id subjectType subjectId amount capturedAmount refundedAmount reservedRefundAmount netPaidAmount currency purpose status createdAt updatedAt verifiedAt").lean();
  if (!payment) throw notFound();
  res.json({ success: true, data: payment });
});
export const requestRefund = catchAsync(async (req, res) => {
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 128) throw new AppError("Idempotency-Key is required", 400);
  const result = await reserveRefund({ paymentId: req.params.paymentId, requestedBy: req.user.id, amount: req.body.amount, currency: req.body.currency, reason: req.body.reason, idempotencyKey });
  if (result.replayed) res.set("Idempotency-Replayed", "true");
  res.status(result.replayed ? 200 : 202).json({ success: true, data: result.refund });
});
export const listReconciliations = catchAsync(async (req, res) => {
  res.json({ success: true, data: await ReconciliationCase.find().sort({ lastObservedAt: -1 }).limit(100).lean() });
});
export const getReconciliation = catchAsync(async (req, res) => {
  const record = await ReconciliationCase.findById(req.params.id).lean();
  if (!record) throw new AppError("Reconciliation record not found", 404);
  res.json({ success: true, data: record });
});
export const resolveReconciliation = catchAsync(async (req, res) => {
  const record = await ReconciliationCase.findOneAndUpdate({ _id: req.params.id, status: "OPEN" }, { $set: { status: "RESOLVED", resolvedBy: req.user.id, resolutionReason: req.body.reason } }, { returnDocument: "after", runValidators: true });
  if (!record) throw new AppError("Reconciliation record is unavailable", 409);
  await writeAuditLog(req.user.id, "RECONCILIATION_RESOLVED", "ReconciliationCase", record._id, { reason: req.body.reason });
  res.json({ success: true, data: record });
});
export const createFinanceOverride = catchAsync(async (req, res) => {
  const override = await createRepairFinanceOverride({
    repairId: req.params.repairId,
    actorId: req.user.id,
    actorRole: req.user.role,
    scope: req.body.scope,
    reason: req.body.reason,
  });
  res.status(201).json({ success: true, data: override });
});
export const revokeFinanceOverride = catchAsync(async (req, res) => {
  const override = await revokeRepairFinanceOverride({
    overrideId: req.params.overrideId,
    actorId: req.user.id,
    actorRole: req.user.role,
    reason: req.body.reason,
  });
  res.json({ success: true, data: override });
});
