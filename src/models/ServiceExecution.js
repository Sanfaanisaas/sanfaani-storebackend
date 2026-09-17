import mongoose from "mongoose";

export const SERVICE_EXECUTION_STATUSES = Object.freeze(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);

const actionSchema = new mongoose.Schema({
  idempotencyKey: { type: String, maxlength: 128, default: null, select: false },
  fingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: null, select: false },
  at: { type: Date, default: null },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  serviceRequest: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceRequest", required: true, unique: true, immutable: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  quotation: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceQuotation", required: true, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true },
    totalAmount: { type: Number, required: true, min: 0, immutable: true },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/, immutable: true },
    estimatedDays: { type: Number, required: true, min: 0, immutable: true },
  },
  assignedTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  schedule: {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    mode: { type: String, enum: ["onsite", "drop_off", "pickup", "remote"], required: true },
    location: { type: String, trim: true, maxlength: 300, default: null },
  },
  deviceSafeLabel: { type: String, required: true, trim: true, maxlength: 200 },
  status: { type: String, enum: SERVICE_EXECUTION_STATUSES, default: "SCHEDULED", index: true },
  version: { type: Number, min: 1, default: 1 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, trim: true, maxlength: 500, default: null },
  completion: {
    workSummary: { type: String, trim: true, maxlength: 2000, default: null },
    customerVisiblePartsAndServices: { type: [String], default: [] },
    warrantyOutcome: { type: String, trim: true, maxlength: 500, default: null },
    nextRecommendedMaintenance: { type: String, trim: true, maxlength: 500, default: null },
    internalNotes: { type: String, trim: true, maxlength: 3000, default: null, select: false },
  },
  internalNotes: { type: String, trim: true, maxlength: 3000, default: null, select: false },
  actions: {
    schedule: { type: actionSchema, default: () => ({}) },
    start: { type: actionSchema, default: () => ({}) },
    complete: { type: actionSchema, default: () => ({}) },
    cancel: { type: actionSchema, default: () => ({}) },
  },
}, { timestamps: true });

schema.pre("validate", function validateSchedule() {
  if (this.schedule?.startAt && this.schedule?.endAt && this.schedule.endAt <= this.schedule.startAt) {
    this.invalidate("schedule.endAt", "Scheduled end must be after scheduled start");
  }
});
schema.index({ assignedTechnician: 1, status: 1, "schedule.startAt": 1 }, { name: "technician_service_schedule" });

export default mongoose.model("ServiceExecution", schema);
