import mongoose from "mongoose";
const { Schema } = mongoose;
import { REPAIR_STATUS } from "../utils/constants.js";

const RepairSchema = new Schema({
  customer: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  device: {
    type: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    serialNumber: { type: String },
  },
  issueDescription: {
    type: String,
    required: true,
  },
  privacyAcknowledged: {
    type: Boolean,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(REPAIR_STATUS),
    default: REPAIR_STATUS.REQUESTED,
  },
  technician: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
  dueAt: { type: Date, default: null, index: true },
  priority: { type: String, enum: ["LOW", "NORMAL", "HIGH", "URGENT"], default: "NORMAL" },
  blockerCode: { type: String, default: null, maxlength: 64 },
  blockerMessage: { type: String, default: null, maxlength: 500 },
  intakePhotos: [String],
  intakeCondition: String,
  diagnosisNotes: String,
  estimatedCost: Number,
  workLog: [{
    note: { type: String, required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, default: Date.now },
  }],
  quoteVersionCounter: { type: Number, default: 0, select: false },
  financial: {
    acceptedQuote: {
      quoteId: { type: Schema.Types.ObjectId, ref: "Quote", default: null },
      version: { type: Number, default: null },
      totalAmount: { type: Number, default: 0 },
      currency: { type: String, default: "NGN" },
      acceptedAt: { type: Date, default: null },
    },
    acceptedQuoteTotal: { type: Number, default: 0, min: 0 },
    requiredDepositAmount: { type: Number, default: 0, min: 0 },
    depositCurrency: { type: String, default: "NGN" },
    depositVerificationState: { type: String, enum: ["NOT_REQUIRED", "PENDING", "VERIFIED", "FAILED", "REVERSED"], default: "NOT_REQUIRED" },
    confirmedPaidAmount: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },
    netPaidAmount: { type: Number, default: 0, min: 0 },
    financeGateState: { type: String, enum: ["CLEAR", "DEPOSIT_REQUIRED", "OUTSTANDING", "RECONCILIATION_REQUIRED", "OVERRIDDEN"], default: "DEPOSIT_REQUIRED" },
    financeGateEvaluatedAt: { type: Date, default: null },
    outstandingBalance: { type: Number, default: 0, min: 0 },
    refundCancellationState: { type: String, enum: ["NONE", "CANCELLATION_REQUESTED", "REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED"], default: "NONE" },
    lastGateEvaluatedAt: { type: Date, default: null },
  },
  qcRecord: {
    checklistVersion: { type: String, default: null },
    results: { type: Schema.Types.Mixed, default: null },
    passed: { type: Boolean, default: false },
    officer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    performedAt: { type: Date, default: null },
    evidenceIds: { type: [Schema.Types.ObjectId], default: [] },
    failureReasons: { type: [String], default: [] },
  },
}, { timestamps: true });

RepairSchema.pre("validate", function () {
  if (this.privacyAcknowledged !== true) {
    this.invalidate("privacyAcknowledged", "Privacy acknowledgement is required to create a repair request.");
  }
});

export default mongoose.model("Repair", RepairSchema);
