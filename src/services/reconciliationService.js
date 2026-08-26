import crypto from "node:crypto";
import ReconciliationCase from "../models/ReconciliationCase.js";
import { writeAuditLog } from "./auditService.js";

const MAX_OCCURRENCES = 10000;
const objectIdString = (value) => value ? value.toString() : null;
const digest = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

const allowedState = (value = {}) => ({
  amount: Number.isSafeInteger(value.amount) && value.amount >= 0 ? value.amount : null,
  currency: typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null,
  subjectType: value.subjectType === "order" || value.subjectType === "repair" ? value.subjectType : null,
  subjectId: typeof value.subjectId === "string" && /^[a-fA-F0-9]{24}$/.test(value.subjectId) ? value.subjectId : null,
  owner: typeof value.owner === "string" && /^[a-fA-F0-9]{24}$/.test(value.owner) ? value.owner : null,
  purpose: typeof value.purpose === "string" ? value.purpose.slice(0, 64) : null,
  quoteVersion: Number.isSafeInteger(value.quoteVersion) && value.quoteVersion >= 0 ? value.quoteVersion : null,
  paymentStatus: typeof value.paymentStatus === "string" ? value.paymentStatus.slice(0, 32) : null,
  refundStatus: typeof value.refundStatus === "string" ? value.refundStatus.slice(0, 32) : null,
  providerReferenceDigest: value.providerReferenceDigest && /^[a-f0-9]{64}$/.test(value.providerReferenceDigest) ? value.providerReferenceDigest : null,
});

const keyFor = ({ category, payment, refund, subjectType, subjectId, eventDigest, expected, observed }) => crypto
  .createHash("sha256")
  .update(JSON.stringify({
    category,
    payment: objectIdString(payment),
    refund: objectIdString(refund),
    subjectType: subjectType || null,
    subjectId: objectIdString(subjectId),
    eventDigest: eventDigest || null,
    expected,
    observed,
  }))
  .digest("hex");

/**
 * Create one safe, deduplicated reconciliation case or touch its occurrence.
 * Callers provide only normalized values; complete callback bodies are never
 * accepted here. The audit record uses the same session as the case.
 */
export const createOrTouchReconciliationCase = async ({
  category,
  payment = null,
  refund = null,
  subjectType = null,
  subjectId = null,
  currency = null,
  expected = {},
  observed = {},
  providerEventId = null,
  eventDigest = null,
  createdBy = null,
  session,
}) => {
  const normalizedExpected = allowedState(expected);
  const normalizedObserved = allowedState(observed);
  const resolvedEventDigest = eventDigest || digest(providerEventId);
  const deduplicationKey = keyFor({
    category, payment, refund, subjectType, subjectId, eventDigest: resolvedEventDigest,
    expected: normalizedExpected, observed: normalizedObserved,
  });
  const now = new Date();
  let record = await ReconciliationCase.findOne({ deduplicationKey }).session(session);
  let created = false;
  if (!record) {
    try {
      [record] = await ReconciliationCase.create([{
        category, payment, refund, subjectType, subjectId, currency,
        expected: normalizedExpected, observed: normalizedObserved,
        eventDigest: resolvedEventDigest, deduplicationKey, occurrenceCount: 1,
        firstObservedAt: now, lastObservedAt: now, createdBy,
      }], { session });
      created = true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      record = await ReconciliationCase.findOne({ deduplicationKey }).session(session);
      if (!record) throw error;
    }
  }
  if (!created) {
    const update = { $set: { lastObservedAt: now } };
    if (record.occurrenceCount < MAX_OCCURRENCES) update.$inc = { occurrenceCount: 1 };
    record = await ReconciliationCase.findOneAndUpdate(
      { _id: record._id }, update, { returnDocument: "after", session, runValidators: true },
    );
  }
  if (createdBy && (created || record.occurrenceCount <= 20)) {
    await writeAuditLog(
      createdBy,
      created ? "RECONCILIATION_CREATED" : "RECONCILIATION_REOBSERVED",
      "ReconciliationCase",
      record._id,
      { category, eventDigest: resolvedEventDigest, occurrenceCount: record.occurrenceCount },
      session,
    );
  }
  return { record, created };
};

export const digestProviderIdentifier = digest;
