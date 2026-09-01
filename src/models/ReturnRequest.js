import mongoose from "mongoose";

const timelineSchema = new mongoose.Schema({
  status: { type: String, enum: ["SUBMITTED", "INSPECTION_REQUIRED", "UNDER_INSPECTION", "APPROVED", "REJECTED", "REMEDY_IN_PROGRESS", "RESOLVED", "CANCELLED"], required: true },
  at: { type: Date, required: true, default: Date.now },
  message: { type: String, trim: true, maxlength: 500, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  items: { type: [{ variantSku: { type: String, required: true }, quantity: { type: Number, required: true, min: 1 }, acceptedQuantity: { type: Number, default: 0, min: 0 } }], required: true },
  reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
  evidenceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  status: { type: String, enum: ["SUBMITTED", "INSPECTION_REQUIRED", "UNDER_INSPECTION", "APPROVED", "REJECTED", "REMEDY_IN_PROGRESS", "RESOLVED", "CANCELLED"], default: "SUBMITTED", index: true },
  remedy: { type: String, enum: ["repair", "replacement", "refund", "store_credit", null], default: null },
  customerSafeTimeline: { type: [timelineSchema], default: () => [{ status: "SUBMITTED", at: new Date(), message: "Return request submitted" }] },
  nextAction: { type: String, trim: true, maxlength: 500, default: null },
  idempotencyKey: { type: String, trim: true, minlength: 1, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, match: /^[a-f0-9]{64}$/, immutable: true },
  privateNotes: { type: String, select: false, maxlength: 2000, default: null },
}, { timestamps: true });

schema.index({ order: 1, status: 1 });
schema.index({ owner: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "customer_return_idempotency" });
export default mongoose.model("ReturnRequest", schema);
