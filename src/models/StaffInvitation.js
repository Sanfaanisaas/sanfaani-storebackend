import mongoose from "mongoose";

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  tokenDigest: { type: String, required: true, unique: true, match: /^[a-f0-9]{64}$/, select: false, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  idempotencyKey: { type: String, required: true, maxlength: 128, select: false, immutable: true },
  idempotencyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false, immutable: true },
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, versionKey: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "staff_invitation_ttl" });
schema.index({ createdBy: 1, idempotencyKey: 1 }, { unique: true, name: "staff_invitation_idempotency" });
schema.index({ user: 1, usedAt: 1, revokedAt: 1 }, { name: "active_staff_invitation" });

export default mongoose.model("StaffInvitation", schema);
