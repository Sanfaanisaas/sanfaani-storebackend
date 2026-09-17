import mongoose from "mongoose";

const schema = new mongoose.Schema({
  event: { type: String, required: true, immutable: true, index: true },
  source: { type: String, enum: ["client", "trusted_server"], required: true, immutable: true, index: true },
  subjectKey: { type: String, select: false, immutable: true },
  anonymousKey: { type: String, select: false, immutable: true },
  properties: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  idempotencyKey: { type: String, select: false, immutable: true },
  idempotencyFingerprint: { type: String, select: false, immutable: true },
  occurredAt: { type: Date, required: true, default: Date.now, immutable: true, index: true },
  expiresAt: { type: Date, required: true, immutable: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true, versionKey: false });
schema.index({ subjectKey: 1, idempotencyKey: 1 }, { unique: true, sparse: true, name: "analytics_subject_idempotency" });
schema.index({ event: 1, source: 1, occurredAt: -1 }, { name: "analytics_kpi_window" });
export default mongoose.model("AnalyticsEvent", schema);
