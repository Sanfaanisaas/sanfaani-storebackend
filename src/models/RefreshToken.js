import mongoose from "mongoose";

const { Schema } = mongoose;

const refreshTokenSchema = new Schema({
  jti: { type: String, required: true, unique: true, immutable: true },
  sessionId: { type: String, required: true, immutable: true },
  familyId: { type: String, required: true, immutable: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  tokenDigest: { type: String, required: true, unique: true, immutable: true, select: false },
  issuedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  lastUsedAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ["active", "rotated", "revoked"],
    required: true,
    default: "active",
  },
  rotatedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revocationReason: { type: String, maxlength: 80, default: null },
  replacedByJti: { type: String, default: null },
}, { timestamps: false, versionKey: false });

refreshTokenSchema.index({ sessionId: 1, issuedAt: -1 });
refreshTokenSchema.index({ familyId: 1, status: 1 });
refreshTokenSchema.index({ user: 1, sessionId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("RefreshToken", refreshTokenSchema);
