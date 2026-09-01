import mongoose from "mongoose";

export const PROCUREMENT_REQUEST_STATUSES = Object.freeze([
  "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "QUOTATION_ISSUED",
  "AWAITING_DECISION", "APPROVED", "DECLINED", "EXPIRED", "CONVERSION_PENDING",
  "CONVERTED_TO_ORDER", "CLOSED", "CANCELLED",
]);

const requirementSchema = new mongoose.Schema({
  category: { type: String, required: true, trim: true, maxlength: 120 },
  quantity: { type: Number, required: true, min: 1, max: 10000 },
  minimumSpecifications: { type: String, required: true, trim: true, maxlength: 2000 },
  preferredCondition: { type: String, enum: ["new", "refurbished", "either"], default: "either" },
  notes: { type: String, trim: true, maxlength: 1000, default: null },
}, { _id: true });

const timelineSchema = new mongoose.Schema({
  status: { type: String, enum: PROCUREMENT_REQUEST_STATUSES, required: true },
  at: { type: Date, required: true, default: Date.now },
  message: { type: String, trim: true, maxlength: 500, default: null },
}, { _id: false });

const clarificationSchema = new mongoose.Schema({
  question: { type: String, trim: true, maxlength: 1000, required: true },
  response: { type: String, trim: true, maxlength: 1000, default: null },
  requestedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
}, { _id: true });

const schema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  organisationName: { type: String, required: true, trim: true, maxlength: 160 },
  organisationType: { type: String, enum: ["business", "school", "nonprofit", "government", "other"], required: true },
  contactName: { type: String, required: true, trim: true, maxlength: 160 },
  contactEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  contactPhone: { type: String, required: true, trim: true, maxlength: 40 },
  requirements: { type: [requirementSchema], validate: [(items) => items.length > 0 && items.length <= 25, "Provide between one and 25 requirement lines"] },
  budgetMin: { type: Number, min: 0, default: null },
  budgetMax: { type: Number, min: 0, default: null },
  requiredBy: { type: Date, default: null },
  fulfilmentMode: { type: String, enum: ["delivery", "pickup", "either"], default: "either" },
  fulfilmentLocation: { type: String, trim: true, maxlength: 500, default: null },
  softwareAndLicensingNeeds: { type: String, trim: true, maxlength: 2000, default: null },
  warrantyAndSupportNeeds: { type: String, trim: true, maxlength: 2000, default: null },
  setupDeploymentNeeds: { type: String, trim: true, maxlength: 2000, default: null },
  accessibilityNeeds: { type: String, trim: true, maxlength: 2000, default: null },
  notes: { type: String, trim: true, maxlength: 3000, default: null },
  status: { type: String, enum: PROCUREMENT_REQUEST_STATUSES, default: "SUBMITTED", index: true },
  version: { type: Number, default: 1, min: 1 },
  timeline: { type: [timelineSchema], default: () => [{ status: "SUBMITTED", at: new Date(), message: "Request received" }] },
  clarifications: { type: [clarificationSchema], default: [] },
  idempotencyKey: { type: String, trim: true, minlength: 1, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, match: /^[a-f0-9]{64}$/, immutable: true },
}, { timestamps: true });

schema.pre("validate", function validateBudget() {
  if (this.budgetMin != null && this.budgetMax != null && this.budgetMin > this.budgetMax) this.invalidate("budgetMax", "Budget maximum must be at least budget minimum");
});
schema.index({ customer: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "customer_procurement_idempotency" });
schema.index({ customer: 1, updatedAt: -1 }, { name: "customer_procurement_list" });

export default mongoose.model("ProcurementRequest", schema);
