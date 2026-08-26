import mongoose from "mongoose";

const { Schema } = mongoose;

export const FINANCE_OVERRIDE_SCOPES = Object.freeze(["ALL", "WORK_START", "QC", "READY", "HANDOVER"]);
export const FINANCE_OVERRIDE_STATUSES = Object.freeze(["ACTIVE", "REVOKED", "SUPERSEDED"]);

const stateSchema = new Schema({
  financeGateState: { type: String, enum: ["CLEAR", "DEPOSIT_REQUIRED", "OUTSTANDING", "RECONCILIATION_REQUIRED", "OVERRIDDEN"], required: true },
  acceptedQuoteTotal: { type: Number, required: true, min: 0 },
  requiredDeposit: { type: Number, required: true, min: 0 },
  verifiedPaid: { type: Number, required: true, min: 0 },
  verifiedRefunded: { type: Number, required: true, min: 0 },
  netPaid: { type: Number, required: true, min: 0 },
  outstandingBalance: { type: Number, required: true, min: 0 },
}, { _id: false, strict: "throw" });

const repairFinanceOverrideSchema = new Schema({
  repair: { type: Schema.Types.ObjectId, ref: "Repair", required: true, immutable: true, index: true },
  scope: { type: String, enum: FINANCE_OVERRIDE_SCOPES, required: true, immutable: true },
  status: { type: String, enum: FINANCE_OVERRIDE_STATUSES, default: "ACTIVE", required: true },
  reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
  beforeState: { type: stateSchema, required: true, immutable: true },
  afterState: { type: stateSchema, required: true, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  revokedAt: { type: Date, default: null },
  revocationReason: { type: String, default: null, trim: true, maxlength: 500 },
  supersededBy: { type: Schema.Types.ObjectId, ref: "RepairFinanceOverride", default: null },
}, { timestamps: true });

repairFinanceOverrideSchema.index(
  { repair: 1, scope: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "ACTIVE" }, name: "one_active_repair_finance_override_per_scope" },
);
repairFinanceOverrideSchema.index({ repair: 1, createdAt: -1 }, { name: "repair_finance_override_history" });

export default mongoose.model("RepairFinanceOverride", repairFinanceOverrideSchema);
