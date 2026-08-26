import mongoose from "mongoose";

// This is intentionally a narrow, record-backed outbox.  Workers may act only
// on a key that was written by an evidence transaction; they never scan a bucket
// prefix or infer a key from user input.
const schema = new mongoose.Schema({
  evidence: { type: mongoose.Schema.Types.ObjectId, ref: "Evidence", default: null, index: true },
  objectKey: { type: String, required: true, select: false, maxlength: 180 },
  taskType: { type: String, enum: ["DELETE_ORPHAN", "FINALIZE_DELETION"], required: true },
  deduplicationKey: { type: String, required: true, unique: true, match: /^[a-f0-9]{64}$/ },
  status: { type: String, enum: ["PENDING", "PROCESSING", "COMPLETED", "EXHAUSTED"], default: "PENDING", index: true },
  attempts: { type: Number, default: 0, min: 0, max: 8 },
  maxAttempts: { type: Number, default: 5, min: 1, max: 8 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastErrorCategory: { type: String, default: null, maxlength: 48 },
  completedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

schema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.model("EvidenceCleanupTask", schema);
