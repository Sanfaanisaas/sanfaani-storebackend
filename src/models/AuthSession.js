import mongoose from "mongoose";

const { Schema } = mongoose;

const authSessionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true, immutable: true },
  familyId: { type: String, required: true, unique: true, immutable: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  currentJti: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
  lastUsedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revocationReason: { type: String, maxlength: 80, default: null },
  deviceLabel: { type: String, maxlength: 160, default: "Unknown device" },
  createdIpDigest: { type: String, maxlength: 64, select: false },
  lastUsedIpDigest: { type: String, maxlength: 64, select: false },
}, { versionKey: false });

authSessionSchema.index({ user: 1, createdAt: -1 });
authSessionSchema.index({ user: 1, sessionId: 1 });
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("AuthSession", authSessionSchema);
