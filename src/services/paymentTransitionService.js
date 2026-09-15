import crypto from "node:crypto";
import mongoose from "mongoose";
import Payment from "../models/Payment.js";
import Refund from "../models/Refund.js";
import Order from "../models/Order.js";
import Repair from "../models/Repair.js";
import AppError from "../utils/AppError.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { writeAuditLog } from "./auditService.js";
import { createOrTouchReconciliationCase, digestProviderIdentifier } from "./reconciliationService.js";
import { evaluateRepairFinanceGate } from "./repairFinanceService.js";
import { allocateOrderReservations, releaseOrderReservations } from "./reservationService.js";
import { canSnapshotFinancialOrder, createVerifiedFinancialDocuments } from "./financialDocumentService.js";

const PAYMENT_SUCCESS = new Set(["SUCCEEDED", "PARTIALLY_REFUNDED"]);
const PAYMENT_TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "REFUNDED", "DISPUTED"]);
const ACTIVE_REFUNDS = new Set(["RESERVED", "PROVIDER_PENDING"]);
const FAILURE_CATEGORIES = new Set(["provider_declined", "provider_error", "provider_rejected", "timeout", "cancelled"]);

const conflict = (code, message) => new AppError(message, 409, [{ code, message }]);
const unavailable = (kind = "Payment") => new AppError(`${kind} is unavailable`, 404, [{ code: `${kind.toLowerCase()}_unavailable`, message: "Check the reference and permissions" }]);
const validObjectId = (value) => mongoose.isObjectIdOrHexString(value);
const digest = (value) => digestProviderIdentifier(value);
const boundedText = (value, field, { min = 1, max = 128 } = {}) => {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw new AppError(`${field} is invalid`, 400, [{ code: `${field}_invalid`, message: `${field} must be a bounded string` }]);
  }
  return value.trim();
};
const positiveAmount = (amount) => {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new AppError("Refund amount must be a positive integer minor-unit value", 400, [{ code: "refund_amount_invalid", message: "Provide a positive whole-number amount" }]);
  return amount;
};
const currencyCode = (currency) => {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new AppError("Currency is invalid", 400, [{ code: "currency_invalid", message: "Provide a three-letter uppercase currency" }]);
  return currency;
};
const providerEvent = ({ providerEventId, eventType, providerTimestamp = null, amount = null, currency = null }) => ({
  eventDigest: digest(boundedText(String(providerEventId), "provider event id", { max: 256 })),
  eventType: boundedText(eventType, "provider event type", { max: 64 }),
  receivedAt: new Date(),
  providerTimestamp: providerTimestamp instanceof Date && !Number.isNaN(providerTimestamp.valueOf()) ? providerTimestamp : null,
  amount: Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
  currency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : null,
});
const paymentState = (payment) => ({ amount: payment.amount, currency: payment.currency, subjectType: payment.subjectType, subjectId: payment.subjectId.toString(), owner: payment.owner.toString(), purpose: payment.purpose, quoteVersion: payment.quoteVersion, paymentStatus: payment.status, providerReferenceDigest: digest(payment.providerReference) });
const refundState = (refund) => ({ amount: refund.amount, currency: refund.currency, subjectType: refund.subjectType, subjectId: refund.subjectId.toString(), owner: refund.owner.toString(), purpose: refund.purpose, refundStatus: refund.status, providerReferenceDigest: refund.providerReferenceDigest });

const runTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
};

const reconcile = async ({ session, category, payment = null, refund = null, observed = {}, providerEventId = null, eventDigest = null, actor = null }) => createOrTouchReconciliationCase({
  category,
  payment: payment?._id || refund?.payment || null,
  refund: refund?._id || null,
  subjectType: payment?.subjectType || refund?.subjectType || null,
  subjectId: payment?.subjectId || refund?.subjectId || null,
  currency: payment?.currency || refund?.currency || null,
  expected: payment ? paymentState(payment) : refund ? refundState(refund) : {},
  observed,
  providerEventId,
  eventDigest,
  createdBy: actor || payment?.owner || refund?.owner || null,
  session,
});

const mismatchedPaymentBinding = (payment, normalized = {}) => {
  const metadata = normalized.metadata && typeof normalized.metadata === "object" ? normalized.metadata : {};
  if (normalized.amount !== payment.amount) return "amount_mismatch";
  if (normalized.currency !== payment.currency) return "currency_mismatch";
  if (metadata.subjectType !== payment.subjectType || metadata.subjectId !== payment.subjectId.toString()) return "subject_mismatch";
  if (metadata.owner !== undefined && metadata.owner !== payment.owner.toString()) return "owner_mismatch";
  if (metadata.purpose !== payment.purpose) return "purpose_mismatch";
  if (payment.subjectType === "repair" && metadata.quoteVersion !== payment.quoteVersion) return "quote_version_mismatch";
  return null;
};
const mismatchedRefundBinding = (refund, payment, normalized = {}) => {
  const metadata = normalized.metadata && typeof normalized.metadata === "object" ? normalized.metadata : {};
  if (normalized.amount !== undefined && normalized.amount !== refund.amount) return "refund_amount_mismatch";
  if (normalized.currency !== undefined && normalized.currency !== refund.currency) return "currency_mismatch";
  if (metadata.subjectType !== undefined && metadata.subjectType !== refund.subjectType) return "subject_mismatch";
  if (metadata.subjectId !== undefined && metadata.subjectId !== refund.subjectId.toString()) return "subject_mismatch";
  if (metadata.owner !== undefined && metadata.owner !== refund.owner.toString()) return "owner_mismatch";
  if (metadata.purpose !== undefined && metadata.purpose !== refund.purpose) return "purpose_mismatch";
  if (refund.subjectType === "repair" && metadata.quoteVersion !== undefined && metadata.quoteVersion !== payment.quoteVersion) return "quote_version_mismatch";
  return null;
};

const ensurePaymentSubject = async (payment, session) => {
  if (payment.subjectType === "order") {
    const order = await Order.findOne({ _id: payment.subjectId, userId: payment.owner }).session(session);
    return order ? { order, repair: null, category: null } : { order: null, repair: null, category: "subject_mismatch" };
  }
  const repair = await Repair.findOne({ _id: payment.subjectId, customer: payment.owner, "financial.acceptedQuote.version": payment.quoteVersion, "financial.depositCurrency": payment.currency }).session(session);
  if (!repair) {
    const unscoped = await Repair.findById(payment.subjectId).session(session);
    return { order: null, repair: null, category: unscoped ? "quote_version_mismatch" : "subject_mismatch" };
  }
  return { order: null, repair, category: null };
};

const recalculateRepairFinance = async (repair, session) => {
  const payments = await Payment.find({
    subjectType: "repair", subjectId: repair._id, owner: repair.customer, purpose: "repair_deposit",
    quoteVersion: repair.financial.acceptedQuote.version, currency: repair.financial.depositCurrency,
    status: { $in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] },
  }).session(session);
  const captured = payments.reduce((total, payment) => total + payment.capturedAmount, 0);
  const refunded = payments.reduce((total, payment) => total + payment.refundedAmount, 0);
  const netPaid = payments.reduce((total, payment) => total + payment.netPaidAmount, 0);
  const required = repair.financial.requiredDepositAmount;
  repair.financial.confirmedPaidAmount = captured;
  repair.financial.refundedAmount = refunded;
  repair.financial.netPaidAmount = Math.max(0, netPaid);
  repair.financial.outstandingBalance = Math.max(0, repair.financial.acceptedQuote.totalAmount - repair.financial.netPaidAmount);
  repair.financial.depositVerificationState = required === 0 ? "NOT_REQUIRED" : repair.financial.netPaidAmount >= required ? "VERIFIED" : captured > 0 ? "REVERSED" : "PENDING";
  repair.financial.refundCancellationState = refunded === 0 ? "NONE" : refunded >= captured && captured > 0 ? "REFUNDED" : "PARTIALLY_REFUNDED";
  await evaluateRepairFinanceGate(repair, { session, persist: true });
};

const applyOrderRefundState = async (payment, session) => {
  const full = payment.refundedAmount === payment.capturedAmount;
  const result = await Order.updateOne(
    { _id: payment.subjectId, userId: payment.owner },
    { $set: full ? { paymentStatus: "refunded", status: ORDER_STATUS.REFUNDED } : { paymentStatus: "partially_refunded" } },
    { session, runValidators: true },
  );
  if (!result.matchedCount) throw conflict("refund_subject_unavailable", "The refund subject is unavailable");
};

const validateRefundPaymentLink = (refund, payment) => payment
  && refund.payment.toString() === payment._id.toString()
  && refund.subjectType === payment.subjectType
  && refund.subjectId.toString() === payment.subjectId.toString()
  && refund.owner.toString() === payment.owner.toString()
  && refund.purpose === payment.purpose
  && refund.currency === payment.currency;
const reservationFingerprint = ({ paymentId, amount, currency, reason }) => crypto.createHash("sha256").update(JSON.stringify({ paymentId: String(paymentId), amount, currency, reason })).digest("hex");
const paymentAttemptFingerprint = ({ subjectType, subjectId, owner, amount, currency, purpose, quoteVersion }) => crypto
  .createHash("sha256")
  .update(JSON.stringify({ subjectType, subjectId: String(subjectId), owner: String(owner), amount, currency, purpose, quoteVersion: quoteVersion ?? null }))
  .digest("hex");

/** Payment attempt creation is service-owned; controllers only call the provider afterwards. */
export const createPaymentAttempt = async ({ subjectType, subjectId, owner, idempotencyKey, purpose: requestedPurpose }) => {
  const key = boundedText(idempotencyKey, "Idempotency-Key", { max: 128 });
  if (!["order", "repair"].includes(subjectType) || !validObjectId(subjectId) || !validObjectId(owner)) throw unavailable("Payment subject");
  let requestedFingerprint = null;
  const matches = (payment, fingerprint) => payment && payment.idempotencyFingerprint === fingerprint;
  try {
    return await runTransaction(async (session) => {
      const order = subjectType === "order"
        ? await Order.findOne({ _id: subjectId, userId: owner, paymentStatus: "pending" }).session(session)
        : null;
      const repair = subjectType === "repair"
        ? await Repair.findOne({ _id: subjectId, customer: owner, "financial.acceptedQuote.version": { $ne: null } }).session(session)
        : null;
      if (!order && !repair) throw unavailable("Payment subject");
      const purpose = order ? "order_payment" : "repair_deposit";
      if (requestedPurpose !== undefined && requestedPurpose !== purpose) throw conflict("payment_purpose_unavailable", "Payment purpose is not available for this subject");
      const amount = order ? order.total : repair.financial.requiredDepositAmount;
      const currency = order ? "NGN" : repair.financial.depositCurrency;
      const quoteVersion = repair?.financial?.acceptedQuote?.version ?? null;
      if (!Number.isSafeInteger(amount) || amount < 1 || !/^[A-Z]{3}$/.test(currency)) throw conflict("payment_amount_unavailable", "Payment amount is unavailable");
      const fingerprint = paymentAttemptFingerprint({ subjectType, subjectId, owner, amount, currency, purpose, quoteVersion });
      requestedFingerprint = fingerprint;
      const existing = await Payment.findOne({ owner, idempotencyKey: key }).session(session);
      if (existing) {
        if (!matches(existing, fingerprint)) throw conflict("payment_idempotency_conflict", "Idempotency key cannot be reused with different payment input");
        return { payment: existing, replayed: true };
      }
      const [payment] = await Payment.create([{
        subjectType, subjectId, owner, quoteVersion, provider: "paystack",
        providerReference: `pst_${crypto.randomBytes(24).toString("base64url")}`,
        idempotencyKey: key, idempotencyFingerprint: fingerprint, amount,
        capturedAmount: 0, refundedAmount: 0, reservedRefundAmount: 0, netPaidAmount: 0,
        currency, purpose, status: "PENDING",
      }], { session });
      await writeAuditLog(owner, "PAYMENT_INITIATED", "Payment", payment._id, { subjectType, amount, currency, purpose, quoteVersion }, session);
      return { payment, replayed: false };
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const payment = await Payment.findOne({ owner, idempotencyKey: key });
    if (!payment || payment.subjectType !== subjectType || payment.subjectId.toString() !== String(subjectId)) throw conflict("payment_idempotency_conflict", "Idempotency key cannot be reused with different payment input");
    // A transaction losing the unique-key race compares the stored trusted
    // fingerprint with the fingerprint calculated before its attempted insert.
    if (!requestedFingerprint || !matches(payment, requestedFingerprint)) throw conflict("payment_idempotency_conflict", "Idempotency key cannot be reused with different payment input");
    return { payment, replayed: true };
  }
};

export const applyVerifiedPaymentEvent = async ({ paymentId, providerEventId, eventType, normalized, rawBody }) => {
  if (!validObjectId(paymentId)) throw unavailable();
  const event = providerEvent({ providerEventId, eventType, providerTimestamp: normalized?.paidAt, amount: normalized?.amount, currency: normalized?.currency });
  return runTransaction(async (session) => {
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) throw unavailable();
    const bindingCategory = mismatchedPaymentBinding(payment, normalized);
    if (bindingCategory) {
      await reconcile({ session, category: bindingCategory, payment, observed: { amount: normalized?.amount, currency: normalized?.currency, subjectType: normalized?.metadata?.subjectType, subjectId: normalized?.metadata?.subjectId, owner: normalized?.metadata?.owner, purpose: normalized?.metadata?.purpose, quoteVersion: normalized?.metadata?.quoteVersion, providerReferenceDigest: digest(rawBody) }, providerEventId, actor: payment.owner });
      await writeAuditLog(payment.owner, "PAYMENT_SETTLEMENT_REJECTED", "Payment", payment._id, { category: bindingCategory, eventDigest: event.eventDigest }, session);
      return { payment, reconciled: true };
    }
    if (payment.events.some((entry) => entry.providerEventDigest === event.eventDigest)) {
      if (!payment.duplicateAuditEventDigests.includes(event.eventDigest) && payment.duplicateAuditEventDigests.length < 50) {
        payment.duplicateAuditEventDigests.push(event.eventDigest);
        await payment.save({ session });
        await writeAuditLog(payment.owner, "PAYMENT_SETTLEMENT_DUPLICATE", "Payment", payment._id, { eventDigest: event.eventDigest }, session);
      }
      return { payment, duplicate: true };
    }
    if (payment.status === "SUCCEEDED") {
      await reconcile({ session, category: "duplicate_event_conflict", payment, observed: { ...paymentState(payment), providerReferenceDigest: event.eventDigest }, providerEventId, actor: payment.owner });
      return { payment, reconciled: true };
    }
    if (PAYMENT_TERMINAL.has(payment.status)) {
      await reconcile({ session, category: "out_of_order_terminal_event", payment, observed: { ...paymentState(payment), providerReferenceDigest: event.eventDigest }, providerEventId, actor: payment.owner });
      return { payment, reconciled: true };
    }
    const subject = await ensurePaymentSubject(payment, session);
    if (subject.category) {
      await reconcile({ session, category: subject.category, payment, observed: { ...paymentState(payment), paymentStatus: "subject_unavailable" }, providerEventId, actor: payment.owner });
      return { payment, reconciled: true };
    }
    const previousStatus = payment.status;
    payment.status = "SUCCEEDED";
    payment.capturedAmount = payment.amount;
    payment.refundedAmount = 0;
    payment.reservedRefundAmount = 0;
    payment.netPaidAmount = payment.amount;
    payment.verifiedAt = new Date();
    payment.events.push({ eventId: crypto.randomUUID(), providerEventDigest: event.eventDigest, eventType: event.eventType, previousStatus, resultingStatus: "SUCCEEDED", providerTimestamp: event.providerTimestamp, receivedAt: event.receivedAt, normalizedMetadata: { amount: payment.amount, currency: payment.currency, subjectType: payment.subjectType, quoteVersion: payment.quoteVersion }, payloadDigest: digest(rawBody) });
    await payment.save({ session });
    if (subject.order) {
      const updated = await Order.findOneAndUpdate({ _id: subject.order._id, userId: payment.owner, paymentStatus: "pending" }, { $set: { paymentStatus: "paid", status: ORDER_STATUS.PAID } }, { returnDocument: "after", session });
      if (!updated) throw conflict("payment_subject_unavailable", "The payment subject is unavailable");
      await allocateOrderReservations(updated._id, payment.owner, session);
      // Legacy rows may predate immutable order-line snapshots. Their valid
      // payment transition must remain available, while new checkout orders
      // always satisfy the documentability predicate and receive documents in
      // this same transaction.
      if (canSnapshotFinancialOrder(updated)) {
        await createVerifiedFinancialDocuments({ order: updated, payment, session });
      }
    } else await recalculateRepairFinance(subject.repair, session);
    await writeAuditLog(payment.owner, "PAYMENT_SETTLED", "Payment", payment._id, { subjectType: payment.subjectType, amount: payment.amount, currency: payment.currency }, session);
    return { payment, settled: true };
  });
};

export const processVerifiedPaymentEvent = async ({ provider, providerReference, providerEventId, eventType, normalized, rawBody }) => {
  const reference = boundedText(providerReference, "provider reference", { max: 256 });
  const payment = await Payment.findOne({ provider, providerReference: reference }).select("_id");
  if (payment) return applyVerifiedPaymentEvent({ paymentId: payment._id, providerEventId, eventType, normalized, rawBody });
  return runTransaction(async (session) => {
    const event = providerEvent({ providerEventId, eventType, amount: normalized?.amount, currency: normalized?.currency });
    const reconciliation = await createOrTouchReconciliationCase({ category: "unknown_payment_reference", expected: {}, observed: { amount: normalized?.amount, currency: normalized?.currency, providerReferenceDigest: digest(reference) }, eventDigest: event.eventDigest, session });
    return { payment: null, reconciled: true, reconciliation };
  });
};

export const processVerifiedPaymentFailure = async ({ provider, providerReference, providerEventId, eventType, normalized, rawBody }) => {
  const reference = boundedText(providerReference, "provider reference", { max: 256 });
  const located = await Payment.findOne({ provider, providerReference: reference }).select("_id");
  if (!located) {
    return runTransaction(async (session) => {
      const event = providerEvent({ providerEventId, eventType, amount: normalized?.amount, currency: normalized?.currency });
      const reconciliation = await createOrTouchReconciliationCase({ category: "unknown_payment_reference", expected: {}, observed: { amount: normalized?.amount, currency: normalized?.currency, providerReferenceDigest: digest(reference) }, eventDigest: event.eventDigest, session });
      return { payment: null, reconciled: true, reconciliation };
    });
  }
  return runTransaction(async (session) => {
    const payment = await Payment.findById(located._id).session(session);
    const event = providerEvent({ providerEventId, eventType, providerTimestamp: normalized?.paidAt, amount: normalized?.amount, currency: normalized?.currency });
    const bindingCategory = mismatchedPaymentBinding(payment, normalized);
    if (bindingCategory) {
      await reconcile({ session, category: bindingCategory, payment, observed: { amount: normalized?.amount, currency: normalized?.currency, subjectType: normalized?.metadata?.subjectType, subjectId: normalized?.metadata?.subjectId, owner: normalized?.metadata?.owner, purpose: normalized?.metadata?.purpose, quoteVersion: normalized?.metadata?.quoteVersion, providerReferenceDigest: digest(rawBody) }, providerEventId, actor: payment.owner });
      return { payment, reconciled: true };
    }
    if (payment.events.some((entry) => entry.providerEventDigest === event.eventDigest) || payment.status === "FAILED") return { payment, duplicate: true };
    if (PAYMENT_TERMINAL.has(payment.status)) {
      await reconcile({ session, category: "out_of_order_terminal_event", payment, observed: { ...paymentState(payment), paymentStatus: "FAILED" }, providerEventId, actor: payment.owner });
      return { payment, reconciled: true };
    }
    payment.events.push({ eventId: crypto.randomUUID(), providerEventDigest: event.eventDigest, eventType: event.eventType, previousStatus: payment.status, resultingStatus: "FAILED", providerTimestamp: event.providerTimestamp, receivedAt: event.receivedAt, normalizedMetadata: { amount: payment.amount, currency: payment.currency, subjectType: payment.subjectType, quoteVersion: payment.quoteVersion }, payloadDigest: digest(rawBody) });
    payment.status = "FAILED";
    await payment.save({ session });
    if (payment.subjectType === "order") await releaseOrderReservations(payment.subjectId, payment.owner, "payment_failed", session);
    await writeAuditLog(payment.owner, "PAYMENT_FAILED", "Payment", payment._id, { subjectType: payment.subjectType, amount: payment.amount, currency: payment.currency }, session);
    return { payment, failed: true };
  });
};

/**
 * Refund provider callbacks arrive only after the provider boundary has
 * verified their signature. The callback supplies an opaque refund ID in the
 * provider metadata; transition functions still compare every persisted
 * binding and never perform outbound provider I/O.
 */
export const processVerifiedRefundEvent = async ({ refundId, providerReference, providerEventId, eventType, normalized }) => {
  if (!validObjectId(refundId)) {
    return runTransaction(async (session) => {
      const event = providerEvent({ providerEventId, eventType, providerTimestamp: normalized?.providerTimestamp, amount: normalized?.amount, currency: normalized?.currency });
      return { reconciled: true, reconciliation: await reconcileUnknownRefund({ session, event, providerReference, normalized }) };
    });
  }
  if (eventType === "refund.pending") {
    return markRefundProviderPending({ refundId, providerEventId, providerReference, normalized });
  }
  if (["refund.processed", "refund.success"].includes(eventType)) {
    return settleRefundSuccess({ refundId, providerEventId, providerReference, normalized });
  }
  if (["refund.failed", "refund.rejected"].includes(eventType)) {
    return settleRefundFailure({
      refundId,
      providerEventId,
      providerReference,
      normalized,
      failureCategory: normalized?.failureCategory || "provider_error",
    });
  }
  return { ignored: true };
};

export const reserveRefund = async ({ paymentId, requestedBy, amount, currency, reason, idempotencyKey }) => {
  if (!validObjectId(paymentId) || !validObjectId(requestedBy)) throw unavailable();
  const requestedAmount = positiveAmount(amount);
  const requestedCurrency = currencyCode(currency);
  const normalizedReason = boundedText(reason, "refund reason", { min: 3, max: 500 });
  const key = boundedText(idempotencyKey, "Idempotency-Key", { max: 128 });
  const fingerprint = reservationFingerprint({ paymentId, amount: requestedAmount, currency: requestedCurrency, reason: normalizedReason });
  const replay = async () => {
    const existing = await Refund.findOne({ payment: paymentId, requestedBy, idempotencyKey: key });
    if (!existing) return null;
    if (existing.idempotencyFingerprint !== fingerprint) throw conflict("refund_idempotency_conflict", "Idempotency key was already used with different refund input");
    return { refund: existing, replayed: true };
  };
  const before = await replay();
  if (before) return before;
  try {
    return await runTransaction(async (session) => {
      const existing = await Refund.findOne({ payment: paymentId, requestedBy, idempotencyKey: key }).session(session);
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) throw conflict("refund_idempotency_conflict", "Idempotency key was already used with different refund input");
        return { refund: existing, replayed: true };
      }
      const payment = await Payment.findById(paymentId).session(session);
      if (!payment) throw unavailable();
      if (payment.currency !== requestedCurrency) throw conflict("refund_currency_mismatch", "Refund currency does not match the captured payment");
      if (!PAYMENT_SUCCESS.has(payment.status)) throw conflict("refund_payment_not_captured", "Payment is not refundable");
      const available = payment.capturedAmount - payment.refundedAmount - payment.reservedRefundAmount;
      if (requestedAmount > available) throw conflict("refund_amount_unavailable", "Refund exceeds the available captured balance");
      const reserved = await Payment.findOneAndUpdate({ _id: payment._id, status: { $in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] }, currency: requestedCurrency, $expr: { $gte: [{ $subtract: [{ $subtract: ["$capturedAmount", "$refundedAmount"] }, "$reservedRefundAmount"] }, requestedAmount] } }, { $inc: { reservedRefundAmount: requestedAmount } }, { returnDocument: "after", session, runValidators: true });
      if (!reserved) throw conflict("refund_amount_unavailable", "Refund balance changed; retry with the available amount");
      const [refund] = await Refund.create([{ payment: reserved._id, subjectType: reserved.subjectType, subjectId: reserved.subjectId, owner: reserved.owner, purpose: reserved.purpose, currency: reserved.currency, amount: requestedAmount, status: "RESERVED", idempotencyKey: key, idempotencyFingerprint: fingerprint, provider: reserved.provider, reservedAt: new Date(), reason: normalizedReason, requestedBy }], { session });
      await writeAuditLog(requestedBy, "REFUND_RESERVED", "Refund", refund._id, { amount: refund.amount, currency: refund.currency, refundStatus: refund.status }, session);
      return { refund, replayed: false };
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const afterCollision = await replay();
    if (afterCollision) return afterCollision;
    throw error;
  }
};

const loadRefundAndPayment = async (refundId, session) => {
  if (!validObjectId(refundId)) throw unavailable("Refund");
  const refund = await Refund.findById(refundId).session(session);
  if (!refund) return { refund: null, payment: null, inconsistent: false, unknown: true };
  const payment = await Payment.findById(refund.payment).session(session);
  if (!validateRefundPaymentLink(refund, payment)) {
    await reconcile({ session, category: "provider_database_disagreement", refund, payment, observed: { refundStatus: refund.status }, actor: refund.owner });
    return { refund, payment: null, inconsistent: true, unknown: false };
  }
  return { refund, payment, inconsistent: false, unknown: false };
};
const reconcileUnknownRefund = async ({ session, event, providerReference, normalized }) => createOrTouchReconciliationCase({
  category: "unknown_refund_reference",
  expected: {},
  observed: {
    amount: normalized?.amount,
    currency: normalized?.currency,
    providerReferenceDigest: providerReference ? digest(providerReference) : null,
  },
  eventDigest: event?.eventDigest || null,
  session,
});
const checkRefundProviderEvent = async ({ refund, payment, session, event, providerReference, normalized }) => {
  const category = mismatchedRefundBinding(refund, payment, normalized);
  const referenceDigest = providerReference === undefined || providerReference === null ? null : digest(boundedText(providerReference, "provider reference", { max: 256 }));
  if (category || (refund.providerReferenceDigest && referenceDigest && refund.providerReferenceDigest !== referenceDigest)) {
    await reconcile({ session, category: category || "refund_state_mismatch", refund, payment, observed: { amount: normalized?.amount, currency: normalized?.currency, subjectType: normalized?.metadata?.subjectType, subjectId: normalized?.metadata?.subjectId, owner: normalized?.metadata?.owner, purpose: normalized?.metadata?.purpose, quoteVersion: normalized?.metadata?.quoteVersion, providerReferenceDigest: referenceDigest }, eventDigest: event.eventDigest, actor: refund.owner });
    return { mismatch: true, referenceDigest };
  }
  const duplicatedElsewhere = await Refund.exists({ _id: { $ne: refund._id }, "providerEvents.eventDigest": event.eventDigest }).session(session);
  if (duplicatedElsewhere) {
    await reconcile({ session, category: "duplicate_event_conflict", refund, payment, observed: { providerReferenceDigest: referenceDigest }, eventDigest: event.eventDigest, actor: refund.owner });
    return { mismatch: true, referenceDigest };
  }
  return { mismatch: false, referenceDigest };
};

export const markRefundProviderPending = async ({ refundId, providerEventId, providerReference, normalized = {} }) => {
  const event = providerEvent({ providerEventId, eventType: "refund.pending", providerTimestamp: normalized.providerTimestamp, amount: normalized.amount, currency: normalized.currency });
  return runTransaction(async (session) => {
    const { refund, payment, inconsistent, unknown } = await loadRefundAndPayment(refundId, session);
    if (unknown) return { refund: null, reconciled: true, reconciliation: await reconcileUnknownRefund({ session, event, providerReference, normalized }) };
    if (inconsistent) return { refund, reconciled: true };
    const checked = await checkRefundProviderEvent({ refund, payment, session, event, providerReference, normalized });
    if (checked.mismatch) return { refund, reconciled: true };
    if (refund.status === "PROVIDER_PENDING" && refund.providerEvents.some((entry) => entry.eventDigest === event.eventDigest)) return { refund, duplicate: true };
    if (!ACTIVE_REFUNDS.has(refund.status)) {
      await reconcile({ session, category: "out_of_order_terminal_event", refund, payment, observed: { refundStatus: "PROVIDER_PENDING", providerReferenceDigest: checked.referenceDigest }, eventDigest: event.eventDigest, actor: refund.owner });
      return { refund, reconciled: true };
    }
    if (refund.status === "PROVIDER_PENDING") return { refund, duplicate: true };
    refund.status = "PROVIDER_PENDING";
    refund.providerPendingAt = new Date();
    refund.providerReferenceDigest = checked.referenceDigest || refund.providerReferenceDigest;
    refund.providerEvents.push(event);
    await refund.save({ session });
    await writeAuditLog(refund.requestedBy, "REFUND_PROVIDER_PENDING", "Refund", refund._id, { refundStatus: refund.status, eventDigest: event.eventDigest }, session);
    return { refund, pending: true };
  });
};

export const settleRefundSuccess = async ({ refundId, providerEventId, providerReference, normalized = {} }) => {
  const event = providerEvent({ providerEventId, eventType: "refund.succeeded", providerTimestamp: normalized.providerTimestamp, amount: normalized.amount, currency: normalized.currency });
  return runTransaction(async (session) => {
    const { refund, payment, inconsistent, unknown } = await loadRefundAndPayment(refundId, session);
    if (unknown) return { refund: null, reconciled: true, reconciliation: await reconcileUnknownRefund({ session, event, providerReference, normalized }) };
    if (inconsistent) return { refund, reconciled: true };
    const checked = await checkRefundProviderEvent({ refund, payment, session, event, providerReference, normalized });
    if (checked.mismatch) return { refund, reconciled: true };
    if (refund.status === "SUCCEEDED" && refund.providerEvents.some((entry) => entry.eventDigest === event.eventDigest)) return { refund, duplicate: true };
    if (!ACTIVE_REFUNDS.has(refund.status)) {
      await reconcile({ session, category: "out_of_order_terminal_event", refund, payment, observed: { ...refundState(refund), refundStatus: "SUCCEEDED", providerReferenceDigest: checked.referenceDigest }, eventDigest: event.eventDigest, actor: refund.owner });
      return { refund, reconciled: true };
    }
    const subject = await ensurePaymentSubject(payment, session);
    if (subject.category) {
      await reconcile({ session, category: subject.category, refund, payment, observed: { ...refundState(refund), refundStatus: "SUCCEEDED" }, eventDigest: event.eventDigest, actor: refund.owner });
      return { refund, reconciled: true };
    }
    if (payment.reservedRefundAmount < refund.amount || payment.refundedAmount + refund.amount > payment.capturedAmount) {
      await reconcile({ session, category: "provider_database_disagreement", refund, payment, observed: { ...refundState(refund), paymentStatus: payment.status }, eventDigest: event.eventDigest, actor: refund.owner });
      return { refund, reconciled: true };
    }
    payment.reservedRefundAmount -= refund.amount;
    payment.refundedAmount += refund.amount;
    payment.netPaidAmount = payment.capturedAmount - payment.refundedAmount;
    payment.status = payment.refundedAmount === payment.capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";
    refund.status = "SUCCEEDED";
    refund.succeededAt = new Date();
    refund.reservationReleasedAt = refund.succeededAt;
    refund.providerReferenceDigest = checked.referenceDigest || refund.providerReferenceDigest;
    refund.providerEvents.push(event);
    await payment.save({ session });
    await refund.save({ session });
    if (subject.order) await applyOrderRefundState(payment, session);
    else await recalculateRepairFinance(subject.repair, session);
    await writeAuditLog(refund.requestedBy, "REFUND_SUCCEEDED", "Refund", refund._id, { amount: refund.amount, currency: refund.currency, refundStatus: refund.status, eventDigest: event.eventDigest }, session);
    return { refund, settled: true };
  });
};

const releaseRefundReservation = async ({ refundId, providerEventId, providerReference, normalized = {}, failureCategory = "provider_error", cancelled = false, actor = null }) => {
  const category = cancelled ? "cancelled" : FAILURE_CATEGORIES.has(failureCategory) ? failureCategory : "provider_error";
  const event = cancelled ? null : providerEvent({ providerEventId, eventType: "refund.failed", providerTimestamp: normalized.providerTimestamp, amount: normalized.amount, currency: normalized.currency });
  return runTransaction(async (session) => {
    const { refund, payment, inconsistent, unknown } = await loadRefundAndPayment(refundId, session);
    if (unknown) return { refund: null, reconciled: true, reconciliation: await reconcileUnknownRefund({ session, event, providerReference, normalized }) };
    if (inconsistent) return { refund, reconciled: true };
    let checked = { mismatch: false, referenceDigest: null };
    if (event) {
      checked = await checkRefundProviderEvent({ refund, payment, session, event, providerReference, normalized });
      if (checked.mismatch) return { refund, reconciled: true };
    }
    const target = cancelled ? "CANCELLED" : "FAILED";
    if (refund.status === target && (!event || refund.providerEvents.some((entry) => entry.eventDigest === event.eventDigest))) return { refund, duplicate: true };
    if (!ACTIVE_REFUNDS.has(refund.status) || (cancelled && refund.status !== "RESERVED")) {
      await reconcile({ session, category: "out_of_order_terminal_event", refund, payment, observed: { ...refundState(refund), refundStatus: target }, eventDigest: event?.eventDigest || digest(`cancel:${refund._id}`), actor: refund.owner });
      return { refund, reconciled: true };
    }
    if (payment.reservedRefundAmount < refund.amount) {
      await reconcile({ session, category: "provider_database_disagreement", refund, payment, observed: { ...refundState(refund), paymentStatus: payment.status }, eventDigest: event?.eventDigest || null, actor: refund.owner });
      return { refund, reconciled: true };
    }
    payment.reservedRefundAmount -= refund.amount;
    refund.status = target;
    refund.failureCategory = category;
    refund.reservationReleasedAt = new Date();
    if (cancelled) refund.failedAt = null;
    else {
      refund.failedAt = refund.reservationReleasedAt;
      refund.providerReferenceDigest = checked.referenceDigest || refund.providerReferenceDigest;
      refund.providerEvents.push(event);
    }
    await payment.save({ session });
    await refund.save({ session });
    await writeAuditLog(actor || refund.requestedBy, cancelled ? "REFUND_CANCELLED" : "REFUND_FAILED", "Refund", refund._id, cancelled ? { refundStatus: refund.status } : { refundStatus: refund.status, failureCategory: category, eventDigest: event.eventDigest }, session);
    return { refund, released: true };
  });
};

export const settleRefundFailure = (input) => releaseRefundReservation({ ...input, cancelled: false });
export const cancelReservedRefund = ({ refundId, cancelledBy }) => releaseRefundReservation({ refundId, cancelled: true, actor: cancelledBy });
