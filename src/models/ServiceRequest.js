import mongoose from "mongoose";

export const SERVICE_TYPES = Object.freeze(["DEVICE_UPGRADE", "DEVICE_SETUP", "SOFTWARE_SETUP", "DATA_MIGRATION", "PREVENTIVE_MAINTENANCE", "MAINTENANCE_PLAN"]);
export const SERVICE_REQUEST_STATUSES = Object.freeze(["REQUESTED", "ASSESSMENT_REQUIRED", "INFORMATION_REQUIRED", "COMPATIBLE", "PARTIALLY_COMPATIBLE", "INCOMPATIBLE", "QUOTE_ISSUED", "AWAITING_DECISION", "APPROVED", "DECLINED", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);

const timelineSchema = new mongoose.Schema({
  status: { type: String, enum: SERVICE_REQUEST_STATUSES, required: true },
  at: { type: Date, required: true, default: Date.now },
  message: { type: String, trim: true, maxlength: 500, default: null },
}, { _id: false });

const assessmentSchema = new mongoose.Schema({
  result: { type: String, enum: ["COMPATIBLE", "PARTIALLY_COMPATIBLE", "INCOMPATIBLE"], default: null },
  summary: { type: String, trim: true, maxlength: 2000, default: null },
  assumptions: { type: [String], default: [] },
  requirements: { type: [String], default: [] },
  requiredParts: { type: [String], default: [] },
  requiredSoftware: { type: [String], default: [] },
  limitations: { type: [String], default: [] },
  exclusions: { type: [String], default: [] },
  customerResponsibilities: { type: [String], default: [] },
  nextAction: { type: String, trim: true, maxlength: 500, default: null },
  assessedAt: { type: Date, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  serviceType: { type: String, enum: SERVICE_TYPES, required: true },
  deviceCategory: { type: String, required: true, trim: true, maxlength: 120 },
  brand: { type: String, trim: true, maxlength: 120, default: null },
  model: { type: String, trim: true, maxlength: 160, default: null },
  currentSpecifications: { type: String, trim: true, maxlength: 2000, default: null },
  desiredOutcome: { type: String, required: true, trim: true, maxlength: 2000 },
  softwareRequirements: { type: String, trim: true, maxlength: 2000, default: null },
  dataMigrationRequired: { type: Boolean, default: false },
  licenceOwnershipAcknowledgement: { type: Boolean, required: true },
  backupAcknowledgement: { type: Boolean, required: true },
  fulfilmentPreference: { type: String, enum: ["onsite", "drop_off", "pickup", "remote_assessment"], default: "drop_off" },
  timeConstraints: { type: String, trim: true, maxlength: 500, default: null },
  notes: { type: String, trim: true, maxlength: 3000, default: null },
  responsibilityPolicyVersion: { type: String, required: true, immutable: true },
  status: { type: String, enum: SERVICE_REQUEST_STATUSES, default: "REQUESTED", index: true },
  timeline: { type: [timelineSchema], default: () => [{ status: "REQUESTED", at: new Date(), message: "Service request received" }] },
  assessment: { type: assessmentSchema, default: () => ({}) },
  idempotencyKey: { type: String, trim: true, minlength: 1, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, match: /^[a-f0-9]{64}$/, immutable: true },
}, { timestamps: true });

schema.index({ customer: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "customer_service_idempotency" });
schema.index({ customer: 1, updatedAt: -1 }, { name: "customer_service_list" });

export default mongoose.model("ServiceRequest", schema);
