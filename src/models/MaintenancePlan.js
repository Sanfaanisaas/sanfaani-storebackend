import mongoose from "mongoose";

const schema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  scope: { type: String, required: true, trim: true, maxlength: 1500 },
  coveredDevices: { type: [String], default: [] },
  includedServices: { type: [String], default: [] },
  frequency: { type: String, required: true, trim: true, maxlength: 120 },
  startDate: { type: Date, required: true },
  renewalDate: { type: Date, default: null },
  renewalModel: { type: String, enum: ["manual_renewal", "fixed_term"], required: true },
  visitLimits: { type: String, trim: true, maxlength: 500, default: null },
  exclusions: { type: [String], default: [] },
  status: { type: String, enum: ["ACTIVE", "UPCOMING", "EXPIRED", "CANCELLED"], required: true, index: true },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "NGN", match: /^[A-Z]{3}$/ },
  termsVersion: { type: String, required: true, maxlength: 64 },
  cancellationInstructions: { type: String, required: true, trim: true, maxlength: 1000 },
}, { timestamps: true });

schema.index({ customer: 1, startDate: -1 }, { name: "customer_maintenance_plan_list" });

export default mongoose.model("MaintenancePlan", schema);
