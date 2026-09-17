import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    stockCount: { type: mongoose.Schema.Types.ObjectId, ref: "StockCount", required: true, unique: true },
    variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true, index: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true, index: true },
    expectedQuantity: { type: Number, required: true, min: 0 },
    countedQuantity: { type: Number, required: true, min: 0 },
    variance: { type: Number, required: true },
    status: { type: String, enum: ["OPEN", "RESOLVED"], default: "OPEN", index: true },
    resolution: { type: String, enum: ["ADJUST_STOCK", "ACCEPT_NO_CHANGE"], default: null },
    resolutionReason: { type: String, trim: true, maxlength: 500, default: null },
    resolutionEvidence: { type: mongoose.Schema.Types.ObjectId, ref: "Evidence", default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionIdempotencyKey: { type: String, trim: true, maxlength: 160, default: null },
    resolutionRequestDigest: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  },
  { timestamps: true },
);

schema.index({ status: 1, createdAt: -1 }, { name: "stock_discrepancy_queue" });
schema.index(
  { resolutionIdempotencyKey: 1 },
  { unique: true, partialFilterExpression: { resolutionIdempotencyKey: { $type: "string" } }, name: "unique_stock_resolution_idempotency" },
);

export default mongoose.model("StockDiscrepancy", schema);
