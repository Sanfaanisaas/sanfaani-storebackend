import mongoose from "mongoose";
const line = new mongoose.Schema({ variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true }, quantity: { type: Number, required: true, min: 1 }, unitCost: { type: Number, required: true, min: 0 }, receivedQuantity: { type: Number, default: 0, min: 0 } }, { _id: false });
const receipt = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 160 },
  requestDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true },
  quantity: { type: Number, required: true, min: 1 },
  location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
  evidence: { type: mongoose.Schema.Types.ObjectId, ref: "Evidence", required: true },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  receivedAt: { type: Date, required: true },
}, { _id: true });
const schema = new mongoose.Schema({
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
  status: { type: String, enum: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "RECEIVING", "CLOSED", "CANCELLED"], default: "DRAFT", index: true },
  lines: { type: [line], validate: [(items) => items.length > 0, "Purchase order requires lines"] },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  approvedAt: { type: Date, default: null },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  submittedAt: { type: Date, default: null },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, trim: true, maxlength: 500, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  closedAt: { type: Date, default: null },
  closeReason: { type: String, trim: true, maxlength: 500, default: null },
  evidenceIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Evidence", default: [] },
  receipts: { type: [receipt], default: [] },
  idempotencyKey: { type: String, trim: true, maxlength: 160, default: null },
  requestDigest: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ status: 1, createdAt: -1 }, { name: "purchase_order_status_created" });
schema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "unique_purchase_order_idempotency" },
);
schema.index({ "receipts.idempotencyKey": 1 }, { unique: true, sparse: true, name: "unique_purchase_order_receipt_idempotency" });
export default mongoose.model("PurchaseOrder", schema);
