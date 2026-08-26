import mongoose from "mongoose";

const { Schema } = mongoose;

export const RECONCILIATION_CATEGORIES = Object.freeze([
  "amount_mismatch",
  "currency_mismatch",
  "subject_mismatch",
  "owner_mismatch",
  "purpose_mismatch",
  "quote_version_mismatch",
  "duplicate_event_conflict",
  "out_of_order_terminal_event",
  "provider_database_disagreement",
  "refund_amount_mismatch",
  "refund_state_mismatch",
  "unknown_payment_reference",
  "unknown_refund_reference",
]);

const stateShape = new Schema({
  amount: { type: Number, min: 0, default: null },
  currency: { type: String, match: /^[A-Z]{3}$/, default: null },
  subjectType: { type: String, enum: ["order", "repair"], default: null },
  subjectId: { type: String, maxlength: 24, default: null },
  owner: { type: String, maxlength: 24, default: null },
  purpose: { type: String, maxlength: 64, default: null },
  quoteVersion: { type: Number, min: 0, default: null },
  paymentStatus: { type: String, maxlength: 32, default: null },
  refundStatus: { type: String, maxlength: 32, default: null },
  providerReferenceDigest: { type: String, match: /^[a-f0-9]{64}$/, default: null },
}, { _id: false, strict: "throw" });

const reconciliationCaseSchema = new Schema({
  category: { type: String, enum: RECONCILIATION_CATEGORIES, required: true },
  status: { type: String, enum: ["OPEN", "RESOLVED"], default: "OPEN" },
  payment: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
  refund: { type: Schema.Types.ObjectId, ref: "Refund", default: null },
  subjectType: { type: String, enum: ["order", "repair"], default: null },
  subjectId: { type: Schema.Types.ObjectId, default: null },
  currency: { type: String, match: /^[A-Z]{3}$/, default: null },
  expected: { type: stateShape, required: true },
  observed: { type: stateShape, required: true },
  eventDigest: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  deduplicationKey: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  occurrenceCount: { type: Number, required: true, min: 1, max: 10000, default: 1 },
  firstObservedAt: { type: Date, required: true },
  lastObservedAt: { type: Date, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  resolutionReason: { type: String, default: null, maxlength: 500 },
}, { timestamps: true });

reconciliationCaseSchema.index({ deduplicationKey: 1 }, { unique: true, name: "unique_reconciliation_deduplication_key" });
reconciliationCaseSchema.index({ status: 1, lastObservedAt: -1 }, { name: "reconciliation_open_queue" });

export default mongoose.model("ReconciliationCase", reconciliationCaseSchema);
