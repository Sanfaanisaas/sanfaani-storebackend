import mongoose from "mongoose";

const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  platform: { type: String, enum: ["ios", "android", "web"], required: true },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  deviceIdDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false, immutable: true },
  tokenDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false },
  tokenCiphertext: { type: String, required: true, select: false },
  tokenIv: { type: String, required: true, select: false },
  tokenTag: { type: String, required: true, select: false },
  active: { type: Boolean, default: true, index: true },
  invalidatedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: Date.now },
  idempotencyKey: { type: String, required: true, maxlength: 128, select: false },
  idempotencyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false },
}, { timestamps: true, versionKey: false });

schema.index({ owner: 1, deviceIdDigest: 1 }, { unique: true, name: "push_owner_device" });
schema.index({ tokenDigest: 1 }, { unique: true, name: "push_token_digest" });
schema.index({ owner: 1, idempotencyKey: 1 }, { unique: true, name: "push_registration_idempotency" });

export default mongoose.model("PushDevice", schema);
