import mongoose from "mongoose";

const { Schema } = mongoose;
const eventTypes = [
  "login_succeeded", "login_failed", "refresh_succeeded", "refresh_failed",
  "refresh_reuse_detected", "logout", "session_revoked", "all_sessions_revoked",
];

const securityAuditEventSchema = new Schema({
  event: { type: String, required: true, enum: eventTypes, index: true },
  user: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
  sessionId: { type: String, maxlength: 80, default: null, index: true },
  ipDigest: { type: String, maxlength: 64, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { versionKey: false });

securityAuditEventSchema.index({ createdAt: -1 });

export default mongoose.model("SecurityAuditEvent", securityAuditEventSchema);
