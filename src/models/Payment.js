import mongoose from "mongoose";

const { Schema } = mongoose;
const PAYMENT_STATUSES = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED", "REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED", "REQUIRES_RECONCILIATION"];

const paymentEventSchema = new Schema({
  eventId: { type: String, required: true },
  // Provider event identifiers are not needed for a later provider lookup.  Keep
  // only their digest so that a database export cannot be replayed upstream.
  providerEventDigest: { type: String, match: /^[a-f0-9]{64}$/ },
  eventType: { type: String, required: true },
  previousStatus: { type: String, enum: PAYMENT_STATUSES, default: null },
  resultingStatus: { type: String, enum: PAYMENT_STATUSES, required: true },
  providerTimestamp: { type: Date, default: null },
  receivedAt: { type: Date, required: true },
  normalizedMetadata: {
    type: new Schema({
      amount: { type: Number, min: 0 },
      currency: { type: String, match: /^[A-Z]{3}$/ },
      subjectType: { type: String, enum: ["order", "repair"] },
      quoteVersion: { type: Number, min: 0 },
    }, { _id: false }),
    default: {},
  },
  payloadDigest: { type: String, required: true },
}, { _id: false });

const paymentSchema = new Schema({
  subjectType: { type: String, enum: ["order", "repair"], required: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, index: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  quoteVersion: { type: Number, default: null },
  provider: { type: String, required: true },
  providerReference: { type: String, required: true, unique: true },
  idempotencyKey: { type: String, required: true },
  // New attempts bind an idempotency key to every server-derived financial and
  // subject attribute. Legacy rows can omit this field without being rewritten.
  idempotencyFingerprint: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  amount: { type: Number, required: true, min: 0 },
  // All financial values are integer minor units.  `amount` remains the
  // requested amount for compatibility; these cached totals are authoritative
  // for refund availability and are updated only by transition transactions.
  capturedAmount: { type: Number, required: true, min: 0, default: 0 },
  refundedAmount: { type: Number, required: true, min: 0, default: 0 },
  reservedRefundAmount: { type: Number, required: true, min: 0, default: 0 },
  netPaidAmount: { type: Number, required: true, min: 0, default: 0 },
  currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  purpose: { type: String, required: true },
  status: { type: String, enum: PAYMENT_STATUSES, default: "PENDING" },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  evidence: { type: Schema.Types.ObjectId, ref: "Evidence", default: null },
  // Legacy embedded records are retained for historical reads only. New A2
  // operations use the standalone Refund aggregate and never append here.
  refunds: { type: [{ idempotencyKey: { type: String, required: true }, amount: { type: Number, required: true, min: 1 }, status: { type: String, enum: ["REQUESTED", "PROVIDER_PENDING", "SUCCEEDED", "FAILED"], required: true }, requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, requestedAt: { type: Date, required: true } }], default: [] },
  events: {
    type: [paymentEventSchema],
    default: [],
    validate: [(events) => events.length <= 50, "Payment event history is bounded"],
  },
  duplicateAuditEventDigests: {
    type: [{ type: String, match: /^[a-f0-9]{64}$/ }],
    default: [],
    validate: [(digests) => digests.length <= 50, "Duplicate audit history is bounded"],
  },
}, { timestamps: true });

paymentSchema.index({ owner: 1, idempotencyKey: 1 }, { unique: true, name: "unique_payment_idempotency_per_owner" });
paymentSchema.index({ "events.providerEventDigest": 1 }, { unique: true, sparse: true, name: "unique_provider_event_digest" });
paymentSchema.index({ _id: 1, "refunds.idempotencyKey": 1 }, { unique: true, sparse: true, name: "unique_refund_idempotency_per_payment" });
paymentSchema.index({ _id: 1, status: 1 }, { name: "payment_status_lookup" });

paymentSchema.pre("validate", function enforceRefundAccountingInvariants() {
  const captured = this.capturedAmount;
  const refunded = this.refundedAmount;
  const reserved = this.reservedRefundAmount;
  const net = this.netPaidAmount;
  if (![captured, refunded, reserved, net].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    this.invalidate("capturedAmount", "Payment accounting values must be non-negative integer minor units");
    return;
  }
  if (refunded + reserved > captured) this.invalidate("reservedRefundAmount", "Refunded and reserved totals cannot exceed the captured amount");
  if (net !== captured - refunded) this.invalidate("netPaidAmount", "Net paid must equal captured amount minus refunded amount");
});

export { PAYMENT_STATUSES };
export default mongoose.model("Payment", paymentSchema);
