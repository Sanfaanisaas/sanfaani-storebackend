import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true, index: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true, index: true },
    expectedQuantity: { type: Number, required: true, min: 0 },
    countedQuantity: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["MATCHED", "DISCREPANCY", "RECONCILED"], required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    evidence: { type: mongoose.Schema.Types.ObjectId, ref: "Evidence", required: true },
    discrepancy: { type: mongoose.Schema.Types.ObjectId, ref: "StockDiscrepancy", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 160 },
    requestDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    countScope: { type: String, enum: ["SERIALIZED_LOCATION", "VARIANT_GLOBAL"], required: true },
  },
  { timestamps: true },
);

schema.index({ idempotencyKey: 1 }, { unique: true, name: "unique_stock_count_idempotency" });
schema.index({ location: 1, variant: 1, createdAt: -1 }, { name: "stock_count_lookup" });

export default mongoose.model("StockCount", schema);
