import mongoose from "mongoose";

const { Schema } = mongoose;

export const REFUND_STATUSES = Object.freeze([
  "RESERVED",
  "PROVIDER_PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

const providerEventSchema = new Schema({
  eventDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  eventType: { type: String, required: true, trim: true, maxlength: 64 },
  receivedAt: { type: Date, required: true },
  providerTimestamp: { type: Date, default: null },
  amount: { type: Number, min: 0, default: null },
  currency: { type: String, match: /^[A-Z]{3}$/, default: null },
}, { _id: false });

const refundSchema = new Schema({
  payment: { type: Schema.Types.ObjectId, ref: "Payment", required: true, index: true, immutable: true },
  subjectType: { type: String, enum: ["order", "repair"], required: true, immutable: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  purpose: { type: String, required: true, trim: true, maxlength: 64, immutable: true },
  currency: { type: String, required: true, match: /^[A-Z]{3}$/, immutable: true },
  amount: { type: Number, required: true, min: 1, immutable: true },
  status: { type: String, enum: REFUND_STATUSES, required: true, default: "RESERVED" },
  idempotencyKey: { type: String, required: true, trim: true, minlength: 1, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  provider: { type: String, required: true, trim: true, maxlength: 32, immutable: true },
  providerReferenceDigest: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  providerEvents: {
    type: [providerEventSchema],
    default: [],
    validate: [(events) => events.length <= 20, "Refund provider-event history is bounded"],
  },
  reservedAt: { type: Date, required: true },
  providerPendingAt: { type: Date, default: null },
  succeededAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  reservationReleasedAt: { type: Date, default: null },
  failureCategory: { type: String, default: null, maxlength: 64 },
  reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
}, { timestamps: true });

refundSchema.index({ payment: 1, status: 1 }, { name: "refund_payment_status_totals" });
refundSchema.index(
  { payment: 1, requestedBy: 1, idempotencyKey: 1 },
  { unique: true, name: "unique_refund_idempotency_per_actor_payment" },
);
refundSchema.index(
  { "providerEvents.eventDigest": 1 },
  { unique: true, sparse: true, name: "unique_refund_provider_event_digest" },
);

export default mongoose.model("Refund", refundSchema);
