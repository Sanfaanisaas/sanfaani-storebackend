import mongoose from "mongoose";
import { policyAcceptanceSchema } from "./PolicyVersion.js";
const { Schema } = mongoose;

const WarrantySchema = new Schema({
  order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  orderItemSku: { type: String, default: null, maxlength: 128 },
  repair: { type: Schema.Types.ObjectId, ref: "Repair", default: null },
  customer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  deviceSummary: { type: String, required: true, maxlength: 500 },
  sourceType: { type: String, enum: ["order", "repair"], default: "repair" },
  status: { type: String, enum: ["ACTIVE", "VOID"], default: "ACTIVE", index: true },
  effectiveAt: { type: Date, default: Date.now },
  claimAllowance: { type: Number, min: 0, default: 1 },
  policyVersion: { type: String, default: "2024-01-01", maxlength: 64 },
  policySnapshot: { coverage: { type: String, default: "Standard repair workmanship coverage", maxlength: 1000 }, exclusions: { type: [String], default: [] } },
  policyAcceptances: { type: [policyAcceptanceSchema], default: [], immutable: true },
  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

WarrantySchema.pre("validate", function validateSource() {
  if (!this.order && !this.repair) this.invalidate("sourceType", "A warranty must reference an order or repair");
  if (this.order && this.repair) this.invalidate("sourceType", "A warranty may reference only one covered source");
  if (this.order) this.sourceType = "order";
  if (this.repair) this.sourceType = "repair";
  if (this.effectiveAt && this.expiresAt && this.effectiveAt > this.expiresAt) this.invalidate("expiresAt", "Warranty expiry must follow its effective date");
});
WarrantySchema.index({ customer: 1, expiresAt: 1 }, { name: "customer_warranty_expiry" });

export default mongoose.model("Warranty", WarrantySchema);
