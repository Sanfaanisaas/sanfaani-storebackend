import mongoose from "mongoose";

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true, index: true },
  quantity: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["RESERVED", "ALLOCATED", "RELEASED", "CONSUMED", "EXPIRED"], default: "RESERVED", index: true },
  reservedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  allocatedAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  consumedAt: { type: Date, default: null },
  releaseReason: { type: String, default: null },
}, { timestamps: true });
schema.index({ order: 1, variant: 1 }, { unique: true, name: "unique_order_variant_reservation" });
export default mongoose.model("StockReservation", schema);
