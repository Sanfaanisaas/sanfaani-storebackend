import crypto from "node:crypto";
import mongoose from "mongoose";
import Evidence from "../models/Evidence.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import AppError from "../utils/AppError.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { writeAuditLog } from "./auditService.js";
import {
  deleteEvidenceObject,
  generatedObjectKey,
  putEvidenceObject,
  validateEvidenceFile,
} from "./evidenceStorageService.js";
import { createVerifiedFinancialDocuments } from "./financialDocumentService.js";
import { allocateOrderReservations } from "./reservationService.js";
import { queueEvidenceCleanup } from "./evidenceCleanupService.js";

const unavailable = () =>
  new AppError("Bank-transfer payment is unavailable", 404, [
    {
      code: "bank_transfer_unavailable",
      message: "Check the order reference and permissions",
    },
  ]);

const paymentFingerprint = (order) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({
      subjectType: "order",
      subjectId: order._id.toString(),
      owner: order.userId.toString(),
      amount: order.total,
      currency: "NGN",
      purpose: "order_payment",
    }))
    .digest("hex");

const evidenceDto = (evidence) => ({
  id: evidence._id,
  purpose: evidence.purpose,
  displayName: evidence.displayName,
  detectedMimeType: evidence.detectedMimeType,
  size: evidence.size,
  createdAt: evidence.createdAt,
});

export const attachBankTransferEvidence = async ({ orderId, ownerId, file }) => {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw unavailable();
  const validated = validateEvidenceFile(file);
  const key = generatedObjectKey();
  await putEvidenceObject({
    key,
    body: file.buffer,
    contentType: validated.detectedMimeType,
    checksum: validated.checksum,
  });

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const order = await Order.findOne({
        _id: orderId,
        userId: ownerId,
        paymentMethod: "bank_transfer",
        paymentStatus: "pending",
        status: ORDER_STATUS.PENDING_PAYMENT,
      })
        .select("+paymentEvidence")
        .session(session);
      if (!order) throw unavailable();

      const [evidence] = await Evidence.create(
        [
          {
            subjectType: "order",
            subject: order._id,
            owner: order.userId,
            purpose: "order_receipt",
            ...validated,
            objectKey: key,
            uploader: ownerId,
          },
        ],
        { session },
      );

      let payment = await Payment.findOne({
        subjectType: "order",
        subjectId: order._id,
        owner: order.userId,
        provider: "bank_transfer",
        status: "PENDING",
      }).session(session);
      if (!payment) {
        [payment] = await Payment.create(
          [
            {
              subjectType: "order",
              subjectId: order._id,
              owner: order.userId,
              provider: "bank_transfer",
              providerReference: `bank_${crypto.randomBytes(24).toString("base64url")}`,
              idempotencyKey: `bank-transfer:${order._id}`,
              idempotencyFingerprint: paymentFingerprint(order),
              amount: order.total,
              currency: "NGN",
              purpose: "order_payment",
              status: "PENDING",
              evidence: evidence._id,
            },
          ],
          { session },
        );
      } else {
        payment.evidence = evidence._id;
        await payment.save({ session });
      }

      order.paymentEvidence = evidence._id;
      await order.save({ session });
      await writeAuditLog(
        ownerId,
        "EVIDENCE_UPLOADED",
        "Evidence",
        evidence._id,
        { subjectType: "order", purpose: "order_receipt", size: validated.size },
        session,
      );
      await writeAuditLog(
        ownerId,
        "BANK_TRANSFER_EVIDENCE_ATTACHED",
        "Payment",
        payment._id,
        { amount: payment.amount, currency: payment.currency },
        session,
      );
      result = { order, payment, evidence };
    });
    return {
      order: result.order,
      payment: { id: result.payment._id, status: result.payment.status },
      evidence: evidenceDto(result.evidence),
    };
  } catch (error) {
    try {
      await deleteEvidenceObject(key);
    } catch {
      try {
        await queueEvidenceCleanup({
          taskType: "DELETE_ORPHAN",
          objectKey: key,
          actorId: ownerId,
        });
      } catch {
        // Preserve the original operational error. Neither the object key nor
        // storage diagnostics are logged or returned by this boundary.
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const verifyBankTransferPayment = async ({ orderId, actorId }) => {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw unavailable();
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await Order.findOne({
        _id: orderId,
        paymentMethod: "bank_transfer",
      })
        .select("+paymentEvidence")
        .session(session);
      if (!order) throw unavailable();

      const payment = await Payment.findOne({
        subjectType: "order",
        subjectId: order._id,
        owner: order.userId,
        provider: "bank_transfer",
        status: { $in: ["PENDING", "SUCCEEDED"] },
      })
        .sort({ createdAt: -1, _id: -1 })
        .session(session);
      if (
        !payment?.evidence
        || !order.paymentEvidence
        || payment.evidence.toString() !== order.paymentEvidence.toString()
      ) throw unavailable();
      const evidence = await Evidence.findOne({
        _id: payment.evidence,
        subjectType: "order",
        subject: order._id,
        owner: order.userId,
        purpose: "order_receipt",
        retentionState: "ACTIVE",
      }).session(session);
      if (!evidence) throw unavailable();

      if (payment.status === "SUCCEEDED" && order.paymentStatus === "paid") {
        await createVerifiedFinancialDocuments({ order, payment, session });
        return;
      }
      if (
        payment.status !== "PENDING"
        || order.paymentStatus !== "pending"
        || order.status !== ORDER_STATUS.PENDING_PAYMENT
        || payment.amount !== order.total
        || payment.currency !== "NGN"
      ) {
        throw unavailable();
      }

      const now = new Date();
      const eventId = crypto.randomUUID();
      payment.status = "SUCCEEDED";
      payment.capturedAmount = payment.amount;
      payment.refundedAmount = 0;
      payment.reservedRefundAmount = 0;
      payment.netPaidAmount = payment.amount;
      payment.verifiedAt = now;
      payment.verifiedBy = actorId;
      payment.events.push({
        eventId,
        eventType: "manual.bank_transfer.verified",
        previousStatus: "PENDING",
        resultingStatus: "SUCCEEDED",
        receivedAt: now,
        normalizedMetadata: {
          amount: payment.amount,
          currency: payment.currency,
          subjectType: "order",
        },
        payloadDigest: crypto.createHash("sha256").update(eventId).digest("hex"),
      });
      await payment.save({ session });

      order.paymentStatus = "paid";
      order.status = ORDER_STATUS.PAID;
      order.verifiedBy = actorId;
      order.verifiedAt = now;
      await order.save({ session });
      await allocateOrderReservations(order._id, actorId, session);
      await createVerifiedFinancialDocuments({ order, payment, session });
      await writeAuditLog(
        actorId,
        "BANK_TRANSFER_VERIFIED",
        "Payment",
        payment._id,
        { amount: payment.amount, currency: payment.currency },
        session,
      );
      await writeAuditLog(
        actorId,
        "PAYMENT_SETTLED",
        "Payment",
        payment._id,
        { subjectType: "order", amount: payment.amount, currency: payment.currency },
        session,
      );
    });
    return order;
  } finally {
    await session.endSession();
  }
};
